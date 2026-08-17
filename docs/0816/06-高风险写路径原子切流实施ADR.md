# 高风险写路径原子切流实施 ADR（dispatcher 跨表事务批次）

基线：`dev` 分支 `038be45e` 工作树，2026-08-17。对应 [05-Prisma剩余写路径inventory.md](./05-Prisma剩余写路径inventory.md)
「待迁移高风险写路径」P1 前三行（task enqueue / node·run·event / outbox 合并事务）与
[04-当前迁移状态与待实施清单.md](./04-当前迁移状态与待实施清单.md) 待实施第 4 项。
本 ADR 按 inventory「每条路径的强制盘点字段」六项逐一固定契约，作为切流实施 PR 的前置设计。

## 1. 生产调用方与入口

| 写路径 | 入口 | 生产调用方 |
| --- | --- | --- |
| dispatcher 跨表事务 | `services/src/workflows/dispatcher.ts:32` `dispatchReadyWorkflowNodeSync` | workflow scheduler、outbox 消费侧 `workflow.node.ready`、手动重试/恢复 worker（recovery.ts、retries.ts 经 coordinator 间接触发） |
| task enqueue（事务内） | `db/src/task-queue.ts:27` `enqueueNativeTaskSync` | 仅 dispatcher（`triggerType:"workflow"` 分支）；同文件另有 contacts/messages/auto-continuation 等非 workflow 调用方走同一函数——切流必须覆盖函数级语义，不得只改 dispatcher 一处调用 |
| router session/event（事务内） | `db/src/agent-router-sessions.ts:66` `resolveRouterSessionForTaskSync`；`task-queue.ts:913` `recordRouterLifecycleEvent` → `recordAgentRouterEventSync` | enqueue 内嵌 |
| node/run/event 写（事务内） | `db/src/workflows/runs.ts:474` `claimWorkflowNodeForDispatchSync`、`transitionWorkflowNodeRunSync`、`appendWorkflowRunEventSync`、`lockWorkflowRunForUpdateSync` | dispatcher、coordinator、recovery |
| outbox 插入与业务变更合并 | `db/src/workflows/outbox.ts:14` `enqueueWorkflowOutboxSync` | `services/workflows/coordinator.ts:707`（node.ready）、`materialization.ts:143/269`（run.ready + rerun） |

## 2. 事务边界、锁与提交顺序（现状 legacy）

`dispatchReadyWorkflowNodeSync` = `withTransaction(getDatabase(), …)` 单个同步事务，顺序：

1. `lockWorkflowRunForUpdateSync`：`workflow_run` 行锁（SELECT … FOR UPDATE），防并发 run 级状态变更；
2. `claimWorkflowNodeForDispatchSync`（runs.ts:474，内部再开 `withTransaction`，同连接即加入外层事务）：node run `FOR UPDATE` + 并发计数
   （`status IN ('queued','running')`）→ 超限转 `retry_wait`（`workflow_concurrency_limited`，默认 5s 退避）或 CAS `ready→queued`（`clearError`）；
3. `enqueueNativeTaskSync`：
   a. `readEmployeeRuntimeBindingSync`（读，无写）；
   b. `resolveRouterSessionForTaskSync` → `agent_router_session` upsert（自然键 `workspace_id+agent_id+conversation_key`，命中 UPDATE 复活 status/title，未命中 INSERT）；
   c. `agent_task_queue` INSERT `ON CONFLICT (id) DO NOTHING`；
   d. 读回 queue 行；仅 `inserted=true` 时补 `agent_router_event`（task_queued）与 `task_execution_event`（queued）两条生命周期事件；
4. `transitionWorkflowNodeRunSync`：CAS `from:["queued"]` 写入 `taskQueueId`（失败即 `workflow_node_queue_link_conflict` 整体回滚）；
5. 失败分支：`workflow_task_queue_unavailable` → 转 `retry_wait` + `computeWorkflowQueueRetryAt`（now+60s）+ `node.queue_blocked` 事件；employee 缺失 → `rollbackReady` 后抛错。

**切流目标**：上述 1–5 全部装入**单个 Prisma interactive transaction**
（`prisma.$transaction(async (tx) => …, { isolationLevel: "Serializable" })` 或与 legacy 等价的 Read Committed + 显式 `FOR UPDATE`）。
禁止拆分：node claim、queue insert、router session/event、node link、（outbox 批次的）outbox insert 任何一项留在事务外即丧失原子性——
这正是 inventory P1 第二行「禁止拆成独立非事务写」的原因。

**outbox 合并事务（inventory P1 第三行）**：coordinator.ts:707 / materialization.ts:143/269 的
「业务状态写入 + `enqueueWorkflowOutboxSync`」目前各自散在同步事务里，切流时必须把 outbox 插入并入同一 Prisma 事务
（用 `enqueueWorkflowOutboxPrisma(input, tx)`，adapter 已接受 `client` 参数即为此设计）。

## 3. 幂等键、唯一约束、affected rows、重复请求

| 对象 | 幂等机制 | 重复请求结果（必须对照一致） |
| --- | --- | --- |
| agent_task_queue 行 | id = `queue-idem-sha256(workspaceId\0idempotencyKey)[:32]`；无 key 时 `queue-<random>`。Prisma adapter `createAgentTaskQueuePrisma` 用 `upsert + update:{}` 等价 `ON CONFLICT DO NOTHING` + 读回 | 同 id 二次 dispatch：insert 0 行 → 读回已有行；但 dispatcher 实际重入防护在 node 层（下行） |
| workflow_node_run 状态 | CAS `from:["ready"]` / `from:["queued"]`；`queued && taskQueueId` 直接短路返回 | 二次 dispatch 同一 nodeRunId：步骤 2 读到 `queued+taskQueueId` → 原样返回，不产生新 queue 行/事件 |
| agent_router_session | 自然键 upsert | 同 conversation 二次入队：UPDATE 分支，updated_at 变化，无新行 |
| agent_router_event / task_execution_event | 仅 `inserted=true` 时写一次 | queue 冲突路径**不写**事件（关键对照点：Prisma 版不得因 upsert 读回而误判 inserted） |
| workflow_outbox | legacy 无幂等键（`workflow-outbox-<random>`）；Prisma adapter 已带 enqueue idempotency 契约 | 重复消费/claim 由 `claimWorkflowOutboxBatch` lease CAS 承担；合并事务后 outbox 插入随业务变更一次成组 |

affected-rows 预期：成功路径 queue insert=1、node CAS=1、node link=1、事件 2 条（router+queue lifecycle）、run lock 0 写；
concurrency 超限路径 node transition=1 + run event=1、queue 0。

## 4. PostgreSQL 错误分类与重试

- **deadlock `40P01` / serialization `40001`（Prisma P2034）**：事务整体回滚后重试，上限与退避沿用 cutover 模板
  （默认 ≤3 次、指数退避）；重试计数入 SLO 域 `deadlockRate`/`p2034Rate`（cutover-slo.ts 已有字段）。
  串行化根源：run 行锁与 node 行锁的获取顺序（先 run 后 node）在 Prisma 版必须保持一致，避免与 recovery worker 反向加锁互喂死锁。
- **queue 不可用（binding 缺失 / 写失败）**：不重试事务，转 `retry_wait`（`workflow_task_queue_unavailable`，+60s）——
  Prisma 版必须保留「业务可恢复降级」与「异常抛出」的现有区分：binding 缺失=返回 null→retry_wait；`workflow_node_queue_link_conflict`=抛错回滚。
- **P2002 unique violation**（router session 并发首插、queue id 并发同 id）：按对象幂等语义转 upsert 读回，不计失败。
- 连接层：interactive transaction 占用连接至提交；容量评估走 `prisma:pool:evidence`（04 清单第 1 项），dispatcher 并发度
  （每 worker 串行 + 多 worker）必须计入 web/worker/daemon 三模型压测，事务时长 p95 入 SLO。

## 5. legacy/Prisma 对照、指标与回滚证据

- 套用 `buildDomainCutover` 双 runner 模板，域建议命名 `task-enqueue-dispatch`（dispatcher 事务）与 `workflow-outbox-enqueue`
  （coordinator/materialization 合并事务），各自独立 flag 与 SLO 域；
- shadow 阶段对照字段：返回的 `{nodeRunId, taskQueueId, status}` + 事务内落库五对象
  （queue 行、router session、router/queue 事件、node run 终态）逐字段 equal（含 inputJson、时间戳按 cutover 模板 timestamp 保真规则）；
- 指标：mismatchRate、fallbackRate、errorRate、p95DurationMs、deadlockRate、p2034Rate → 现有 SLO 快照/回滚判定；
  回滚原因新增场景：`link_conflict_spike`（CAS 冲突率异常）、`event_order_drift`（router/queue 事件顺序与 legacy 不一致）；
- write 开启条件：shadow ≥ 指定窗口（沿用 30 天口径）零 mismatch、零 fallback、deadlock/P2034 不高于 legacy 基线。

## 6. flag、负责人与目标版本

| flag | 管辖 | 默认 |
| --- | --- | --- |
| `TASK_QUEUE_PRISMA_WRITE_ENABLED` | 既有：queue 行单表 adapter（已在 b94242bb 落地） | 0 |
| `WORKFLOW_OUTBOX_PRISMA_WRITE_ENABLED` | 既有：outbox 单表 adapter | 0 |
| `WORKFLOW_DISPATCHER_PRISMA_WRITE_ENABLED` | 新增：dispatcher node claim + queue/router/task/run event + outbox lease 的 Serializable interactive transaction | 0 |
| `WORKFLOW_MATERIALIZATION_PRISMA_WRITE_ENABLED` | workflow worker scheduler 的 trigger claim + run/nodes/events/outbox + trigger advance Serializable transaction | 0 |
| `WORKFLOW_TRIGGERS_PRISMA_WRITE_ENABLED` | 既有：trigger lease adapter | 0 |
| `WORKFLOW_DISPATCH_PRISMA_TX_ENABLED`（历史建议，未注册） | 不再使用；由 `WORKFLOW_DISPATCHER_PRISMA_WRITE_ENABLED` 统一控制 node-level transaction | - |
| `WORKFLOW_OUTBOX_MERGE_TX_ENABLED`（历史建议，未注册） | 尚未实现；coordinator/materialization 合并事务保持 legacy | - |

原则：**事务级 flag 与单表 adapter flag 解耦**——开事务 flag 时事务内不走单表 flag 分支（同事务混用两套开关会造成半 Prisma 半 legacy 事务）；`WORKFLOW_MATERIALIZATION_PRISMA_WRITE_ENABLED` 为 worker scheduler 接线的独立事务 flag，所有 flag 注册进 04 清单所述 26 域集中注册表，未知/非法值 fail-closed。负责人：Prisma Phase 2 工作流（用户主理）；legacy 删除条件：两事务域 30 天零 fallback + 零 drift + 池容量达标。

## 7. 实施顺序建议（单 PR 内分步可回退）

1. **已完成 employee_task node.ready 路径**：`prisma/workflow-dispatch-prisma-write.ts` 实现 `Prisma.TransactionClient` 边界——outbox lease claim、run→node 行锁、node claim、router session、queue insert/read、双生命周期事件、run event、node link 和 outbox publish 同一 Serializable transaction；CAS/link affected rows 强制为 1，重复 queue 不再重复写事件；
2. **已接线按类型双 runner**：worker 根据 `WORKFLOW_DISPATCHER_PRISMA_WRITE_ENABLED` 选择 Prisma node-level path，flag 默认 0；`approval` 与非 employee_task 节点显式 claim 后进入 sync legacy，避免全局开关破坏审批流；终态/非 ready employee_task 原子 claim+publish，不再出现结果标记 published 但数据库仍 pending；
3. **已完成 run outbox fan-out**：run.ready/resumed 不再逐节点派发后单独确认；同一 Serializable transaction 内 claim 父事件、锁 run、按 parentOutboxId+nodeRunId 生成确定性 node.ready 子事件并发布父事件，approval/employee_task 由后续批次按类型处理；
4. **已完成数据库故障处理测试**：P2034 有界重试、binding/employee 缺失转 `retry_wait +60s`、已有 queue 不重复写 router/task event、outbox failure 不重复增加 attempt；`workflow-dispatch-prisma-write.integration.test.ts` 在真实 PostgreSQL 验证双 worker 竞争、publish 失败整体回滚、同 run 并发及反向行锁产生的真实 40P01 自动重试；
5. **部分完成**：materialization 已实现 definition/trigger 行锁、run/nodes/events/outbox 与 trigger advance 同一 Serializable transaction，workflow worker auto scheduler 以 `WORKFLOW_MATERIALIZATION_PRISMA_WRITE_ENABLED=1` 接线该路径，并通过真库成功/末段 lease 冲突回滚测试；待完成 coordinator 业务状态 + outbox 合并、legacy/Prisma shadow 对照和 30 天准入证据；
6. 全量 `packages/db` + `services` 相关测试（逐文件运行），SLO 域注册与 `prisma:pool:evidence` 复测。
