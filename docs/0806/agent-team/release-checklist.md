# 工作流引擎首期发布清单

更新时间：2026-08-08

目标分支：`codex/agent-team-workflow`

代码证据：本轮滚动兼容修复基线 `984a10d2`；待发布 SHA 必须取包含本清单的最终已提交版本

发布策略：按 workspace 从 `legacy_only` 逐步切换到 `dual_read`、`workflow_engine`、`legacy_archived`

## 放行结论

当前结论：**代码与本地静态门禁通过，尚不可部署。** 本机未配置隔离测试 PostgreSQL，因而真实迁移 dry-run、Playwright 数据库集成、真实负载/故障演练、镜像构建和环境签字仍待指定测试环境完成。根据仓库约束，本机未启动或触发 Jenkins，也未部署服务。

## 1. 源码与数据库

| 检查项 | 当前状态 | 证据 / 放行条件 |
| --- | --- | --- |
| 目标提交 | 部署时记录完整 40 位 SHA | 发布只能使用包含本清单的已提交版本，不得使用未提交工作树 |
| PostgreSQL schema 版本 | 代码为 `116`，环境待核对 | `packages/db/src/postgres-schema.ts`；测试库 `app_metadata.schema_version` 必须等于 `116`。112 修复 Trigger reparent；113 增加 `approval_deadline`；114 增加审批公平重试游标；115 增加运行历史序号；116 在非空约束前安装旧实例写入兼容触发器。完整 `(workspace_id, created_at DESC, id DESC)` v2 索引在主事务提交后并发创建，不再删除重建旧索引。审批 `expiresAt` 仍以 application JSON metadata 为业务事实，SQL 列用于调度投影；`reviewerUserId`、`risk` 仍只存 metadata |
| Schema 116 滚动兼容 | 代码与仓储测试通过，环境待演练 | 所有 schema 入口按顺序取得 advisory lock 115/116；迁移后用 114/115 形状执行不含 `history_sequence` 的 Run INSERT，确认触发器分配非空序号；模拟中断并发建索引产生 invalid/not-ready 同名索引，确认下一次启动先清理后重建；确认 `idx_workflow_run_workspace_created_v2` 为 valid/ready 后再排空旧 Web/Worker。禁止并行运行绕过锁的手工 DDL。**锁拓扑（契约，Round 4 统一）**：所有 schema 变更入口共享后台维护锁 `117` 作为统一串行边界——CLI/运行时迁移入口（db-init、运行时自动迁移、SQLite/PG 迁移）经 `withSchemaMigrationLock` **先取 117 再按序取迁移锁 `[115,116]`**；后台自愈（history 回填、`SET NOT NULL`、在线建索引，入口 `ensurePostgresConcurrentIndexes`）仅取 `117`。二者在 117 上互斥，滚动升级时迁移 DDL 与后台维护 DDL **绝不并发**（锁顺序恒为 117→[115,116]，无反向获取 → 无死锁）。**冷启动不阻塞**：schema 已当前的冷启动走**无锁快速检查**（`isRuntimeSchemaCurrent`），不竞争任何锁；schema 过期的迁移路径对 117 用**单次非阻塞 `pg_try_advisory_lock`**（忙即快速失败可重试，非阻塞型 `pg_advisory_lock`），避免后台维护贯穿大表回填/建索引（可达分钟级）时令 worker 线程无限挂起、触发 `WORKER_REQUEST_TIMEOUT_MS`（默认 10s）级联杀连接——超时预算不叠加（117 try 瞬间，`[115,116]` 才用 ~9s 超时）。前向版本守卫在锁内首句复检。**跨版本索引名不复用（P1#2 根因）**：`CREATE INDEX … IF NOT EXISTS` 按名判断、不检查定义，跨版本绝不复用索引名——旧实例先建同名旧定义索引会令新版永久跳过正确索引；升级后用 `pnpm db:pg:init` 清理重建。**滚动升级残留（诚实表述）**：已部署的旧版本二进制迁移入口仅取 `[115,116]`、后台维护仅取 117、锁外检查，锁串行化**无法修补已部署旧二进制**——若旧实例先对新库跑旧定义 DDL，仅由 `runBackgroundMaintenance` 的幂等+前向安全兜底（`WHERE history_sequence IS NULL` / `GREATEST…WHERE <` / `isHistorySequenceNullable` 门控 / `CREATE INDEX CONCURRENTLY IF NOT EXISTS`；schema 迁移累加不删 `history_sequence` 列）挽救；建议升级窗口先让单实例完成回填（置 `schema_116_history_backfill_complete=true`）再滚动其余，避免首批多实例在 flag 未置时并发冷启动 |
| 运行历史游标滚动 | Web 定向测试通过，混合环境待演练 | 新签发 v3 使用 `snapshotCount`，114/旧 116 拒绝后客户端重取首屏，115 可按 `snapshotSequence` 续页；114/115 无签名游标由新实例返回 409 后刷新。分别对 114→新、115→新、新→114、新→115、新→旧 116 做双向路由演练 |
| Workflow 表与唯一约束 | 静态测试已覆盖 | 7 张 workspace-scoped 表；`workspace_id + trigger_key`、`run_id + node_id`、`run_id + sequence` 唯一 |
| Legacy 迁移 dry-run | 测试夹具通过，真实统计待填 | 填写 ScheduledTask 总数、自动化规则总数、可迁移、禁用草稿、adapter、冲突和失败数 |
| 单一调度 owner | 代码测试通过，环境待抽查 | 每个 workspace 只能由 legacy 或 workflow 一方创建 trigger |
| 历史保留 | 设计通过，环境待抽查 | archive/disable 不删除 Workflow Run、Event、Artifact 和 Audit |
| 提交日志完整性 | 静态实现与测试入口已完成，实库待验证 | 状态更新保留 revision/artifact；只有实际失败增加 attempt；全局扫描覆盖非默认 workspace；local/remote maintenance 均调用 task-commit-reconcile |

真实迁移 dry-run 结果：

```text
workspace: PENDING
scheduledTasks: PENDING
automationRules: PENDING
createWorkflow: PENDING
disabledDraft: PENDING
legacyAdapter: PENDING
conflicts: PENDING
failed: PENDING
reviewer: PENDING
```

## 2. Worker 与配置

| 检查项 | 当前状态 | 证据 / 放行条件 |
| --- | --- | --- |
| Worker Dockerfile | 静态契约通过 | 启动 `@dofe-agent/workflow-worker`，不内置 PostgreSQL/Redis/RabbitMQ |
| Compose 配置 | `docker compose config` 通过 | 只新增应用 Worker，连接外部 `DATABASE_URL` |
| systemd 配置 | 已提供，未安装 | 独立环境文件、失败重启、30 秒停止超时 |
| Worker 镜像 digest | `PENDING` | 测试环境构建后填写不可变 `sha256:` digest |
| `CRON_SECRET` | 配置项存在，值未核对 | 测试环境使用独立长随机值；不得写入本文或日志 |
| 游标签名密钥 | 配置模板已提供，值未核对 | `WORKFLOW_RUN_CURSOR_SECRET` 未配置时回退 `INTERNAL_API_SECRET`；轮换先配置 previous secret/key id，再切 current，最长分页会话过后才删除 previous；混合旧实例期间专用 current secret 必须保持旧实例可验 |
| Worker ID / poll | 默认已定义，环境待确认 | 每实例唯一 Worker ID；poll 间隔符合容量计划 |
| 共享依赖 | 静态契约通过 | 连接 `../docker-helm.dofe.ai` 管理的外部服务，不新建依赖容器 |

## 3. 安全与观测

| 检查项 | 当前状态 | 证据 / 放行条件 |
| --- | --- | --- |
| 诊断脱敏 | 4 项单测通过 | 字段名、已知 secret、Bearer、递归/超长值均受控且不修改原输入 |
| 指标标签 | 单测通过 | 只接受格式受限 ID、节点类型和状态枚举，不含用户正文 |
| 指标清单 | 已定义 | trigger lag、run duration、node failures、join wait、manual intervention |
| 运维手册 | 已完成 | Worker、Outbox、sequence gap、重复 Run、Runtime、预算、回滚、Legal Hold |
| 告警阈值与看板 | `PENDING` | 测试环境录入 dashboard URL、负责人和值班规则 |
| 日志抽样 | `PENDING` | 抽样确认无 instruction、Secret、input/output 正文、Provider raw message |

## 4. 测试与容量

| 门禁 | 当前状态 | 结果 |
| --- | --- | --- |
| TypeScript / ESLint | 通过 | 根 `pnpm typecheck` 全绿（deps / web / cli / daemon / workflow-worker）；本轮修复 presentation 重复翻译键、triggerPayload `none` 泄漏、channels 合并遗留类型错误、daemon `managedServiceEndpoint` 返回类型后通过 |
| 规格实施覆盖审计 | 通过 | [07-规格实施覆盖矩阵.md](./07-规格实施覆盖矩阵.md) 已区分 DONE / ENV-BLOCKED / EXTERNAL / R2 |
| 部署契约 | 通过 | Node test + Compose 解析通过 |
| 安全单元测试 | 通过 | 4/4 |
| 发布脚本自测 | 通过 | 4/4，覆盖上限与隔离环境保护 |
| 模拟负载 | 通过但不代表真实容量 | 1000 Trigger / 100 Run / 并发 20；P50 27s、P95 49s；重复与 backlog 为 0 |
| 模拟故障演练 | 通过但不代表真实恢复 | Worker stop、重复 completion、sequence gap、Runtime offline，4/4 |
| Playwright 数据库 E2E | `BLOCKED_TEST_ENV` | 本机无 `DOFE_AGENT_TEST_DATABASE_URL`；五个场景已编译，待测试环境执行 |
| 真实负载测试 | `PENDING` | 需 `NODE_ENV=test`、`WORKFLOW_TEST_DATABASE_URL` 和受审 adapter；P95 <= 60s |
| 真实故障演练 | `PENDING` | 必须在隔离 workspace 执行并确认 finally cleanup |
| 提交崩溃矩阵 | `BLOCKED_TEST_ENV` | 在 effects checkpoint、promotion、queue completion、business projection 四个边界终止进程；验证自动收敛或人工补偿 |
| 并行消息隔离 | `BLOCKED_TEST_ENV` | 同员工两个并行节点只更新各自 `taskQueueId` 的等待/终态消息和 mention follow-up |

本地回归快照（2026-08-07）：

```text
Domain: 37 passed
Workflow Service（event/scheduler/security/materialization）: 27 passed
Feishu Outbound（含多审批幂等）: 26 passed
Web Completion/Reconcile/Cron: 18 passed
Web Workflow Builder/Run/Action: 29 passed
CLI Completion Outbox/Token Usage/Daemon Client: 6 passed
Deployment/release configuration: 9 passed
CLI Output/Task Context: BLOCKED_TEST_ENV（缺 PostgreSQL URL 与 TOS 配置）
Web + CLI + dependency TypeScript: passed（含本轮 completion replay、token usage、commit reconcile route）
Web ESLint: passed
PostgreSQL-backed Journal/Queue/Message/Route/Reconciliation/Recovery: BLOCKED_TEST_ENV
Markdown local links + git diff check: passed
```

以上结果只证明无数据库依赖的确定性逻辑、组件和静态契约，不替代 `BLOCKED_TEST_ENV` 项。

## 5. 分阶段切流

1. 选择内部试点 workspace，记录 owner 和回滚人。
2. 保持全局 `WORKFLOW_CUTOVER_MODE=legacy_only`，只对试点写入 workspace override。
3. 切至 `dual_read`，验证日历、自动化中心和编排中心无重复投影，且只有 Workflow 创建 trigger。
4. 切至 `workflow_engine`，观察至少一个完整调度周期及手动运行、审批、失败重试。
5. 达到稳定窗口后切至 `legacy_archived`；旧数据只读，不再自动重新启用。
6. 故障时按运维手册先暂停 trigger，再按 workspace 回滚，禁止全局回退处理单租户问题。

试点记录：

```text
workspace: PENDING
owner: PENDING
rollback owner: PENDING
dual_read start/end: PENDING
workflow_engine start/end: PENDING
legacy_archived time: PENDING
dashboard/evidence: PENDING
```

## 6. 部署与签字

| 项目 | 状态 |
| --- | --- |
| 本地 Jenkins | 禁止，未执行 |
| 远程 Jenkins job | 未授权，未触发 |
| 测试环境部署 | 未执行；需用户提供独立的非 Jenkins 工作流，或在指定 CI/test 环境按其授权流程执行 |
| 生产部署 | 未授权，未执行 |
| 产品验收人 | `PENDING` |
| 工程验收人 | `PENDING` |
| 安全验收人 | `PENDING` |
| 运维验收人 | `PENDING` |
| 最终 go/no-go | `NO-GO`，直到所有 `PENDING`/`BLOCKED_TEST_ENV` 门禁关闭 |
