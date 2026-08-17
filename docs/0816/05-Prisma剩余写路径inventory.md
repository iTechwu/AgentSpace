# Prisma 剩余写路径 inventory

审查基线：`dev` 分支 `b94242bb`，2026-08-17。此清单区分“已有 Prisma 写适配器”和“仍由同步 PostgreSQL/SQLite 路径承担”的事实，不把 Prisma model 存在误判为写迁移完成。

## 已有 Prisma 写适配器

| 域 | 入口 | 当前状态 | 已验证契约 | 退出 legacy 条件 |
| --- | --- | --- | --- | --- |
| audit log | `prisma/audit-log-prisma-write.ts` | 已切流 | upsert 幂等键、主键冲突、错误不重试 | 30 天零 fallback；审计行 source/data 一致 |
| document agent access | `prisma/document-agent-access-prisma-write.ts` | 已切流 | 四列唯一键、grant upsert、revoke COALESCE、affected rows | 主/备结果和撤销语义连续 30 天一致 |
| workspace notifications | `prisma/notifications-prisma-write.ts` | 已切流/仍保留 raw SQL 更新 | create 冲突重试、markRead/archive 的列集与状态保护 | 将 `UPDATE` raw SQL 替换为受审计 Prisma API；完成并发顺序回归 |
| skill drafts | `prisma/skill-drafts-prisma-write.ts` | 已切流 | `(workspace_id, skill_id)` upsert、版本和更新时间语义 | 完成删除/恢复语义、事件审计与 30 天零 fallback |
| task queue row | `prisma/task-queue-prisma-write.ts` | **adapter 已完成 / flag 关闭** | queue id upsert、JSON 映射、状态与时间字段 | 与 node claim、router session/event 同一 Prisma transaction；affected rows、deadlock/P2034 重试与 30 天零 drift |
| workflow outbox | `prisma/workflow-outbox-prisma-write.ts` | **adapter 已完成 / flag 关闭** | enqueue idempotency、transaction claim CAS、lease conflict | 将 workflow 业务变更与 outbox 插入合并为同一事务；重复消费、attempt/backoff 和发布顺序对照 |
| workflow trigger lease | `prisma/workflow-triggers-prisma.ts` | **adapter 已完成 / flag 关闭** | published definition gate、lease CAS、owner release | scheduler/materialization 全链切换；并发抢占/过期 reclaim、P2034/deadlock 重试 |

## 待迁移高风险写路径

| 优先级 | 路径/调用方 | 现状证据 | 必须先固定的契约 | 实施批次 |
| --- | --- | --- | --- | --- |
| P1 | task enqueue：`workflows/dispatcher.ts` → `enqueueNativeTaskSync` | 已有 `createAgentTaskQueuePrisma` queue-row adapter；调用方仍在同步事务内先 claim node，再创建 queue | idempotency key、claim/queue/router event 原子性、队列不可用重试、affected rows、重复 dispatch | 先把 dispatcher 跨表事务改为 Prisma interactive transaction，再做 shadow/write 对照 |
| P1 | workflow node/run/event：`workflows/runs.ts`、`workflows/events.ts` | 多张表同步写入，事件顺序依赖事务提交 | run/node 状态机、版本锁、事件序号、唯一 `(run_id, sequence)` | 与 task enqueue 同批，禁止拆成独立非事务写 |
| P1 | workflow outbox：`workflows/outbox.ts`、`workflows/definitions.ts` | 已有 Prisma enqueue/claim/publish adapter；生产调用仍为 `enqueueWorkflowOutboxSync` | outbox idempotency、delivery lease、attempt/backoff、事件 payload digest | 单独迁移，先比对未投递数量、重复消费和业务变更事务提交顺序 |
| P1 | workflow lease/recovery：`workflows/definitions.ts`、scheduler/reconcile worker | trigger lease Prisma adapter 已实现；recovery/其他 lease 仍是同步 SQL | owner token、expiresAt、compare-and-swap、抢占失败分类 | 先建立并发锁压测，再开 `WORKFLOW_TRIGGERS_PRISMA_WRITE_ENABLED` |
| P2 | pager/集中告警：`pager-alert-state.ts` | 当前同步 upsert；SLO flush 已使用该中心表保存 active/cleared 状态 | alert key、severity、恢复幂等、渠道投递状态 | 接入真实告警路由后再扩展域 |
| P2 | channel access/invitations/participants：`channel-access.ts` | 仍是同步 SQL，多表权限/邀请状态存在联动 | workspace 隔离、唯一键、状态转换、审计事件顺序 | 先完成权限矩阵和 Prisma relation 契约 |
| P2 | skill installation/rollout/reconcile | rollout 计划与安装状态包含一次性审批和 Runtime 绑定 | planDigest/consumedAt、placement、reconcile attempt、跨 Runtime 幂等 | 依赖 0815 全部 P1 门禁，不与普通 CRUD 混迁 |

## 每条路径的强制盘点字段

实施 PR 必须在本表或对应 ADR 补齐：

1. 所有生产调用方和入口文件；
2. 事务边界、锁/隔离级别、提交前后事件顺序；
3. 幂等键、唯一约束、affected rows 预期和重复请求结果；
4. PostgreSQL 错误分类（特别是 deadlock `40P01`、serialization/P2034 `40001`）与重试上限；
5. Prisma 与 legacy 结果对照、指标域、fallback 原因和 rollback reason；
6. shadow/write flag、负责人、目标版本、关闭 legacy 的可观测证据。

## 当前结论

本 inventory 已完成“发现、契约定义和第一批 Prisma adapter”。它仍不表示生产写切流已经实施：dispatcher 的跨表事务、router event 顺序、recovery lease 和真实 deadlock/P2034 重试证据仍缺失；在这些证据完成前，不删除同步 legacy 写路径或开启 write flag。
