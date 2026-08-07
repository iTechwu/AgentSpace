# 工作流引擎首期发布清单

更新时间：2026-08-07

目标分支：`codex/agent-team-workflow`

代码证据：本轮深审起点 `5e3fa1d`；待发布 SHA 必须取本目录所在最终提交

发布策略：按 workspace 从 `legacy_only` 逐步切换到 `dual_read`、`workflow_engine`、`legacy_archived`

## 放行结论

当前结论：**代码与本地静态门禁通过，尚不可部署。** 本机未配置隔离测试 PostgreSQL，因而真实迁移 dry-run、Playwright 数据库集成、真实负载/故障演练、镜像构建和环境签字仍待指定测试环境完成。根据仓库约束，本机未启动或触发 Jenkins，也未部署服务。

## 1. 源码与数据库

| 检查项 | 当前状态 | 证据 / 放行条件 |
| --- | --- | --- |
| 目标提交 | 最终 SHA 待本轮提交后固化 | 发布只能使用本目录所在已提交 SHA，不得使用未提交工作树 |
| PostgreSQL schema 版本 | 代码为 `109`，环境待核对 | `packages/db/src/postgres-schema.ts`；测试库 `app_metadata.schema_version` 必须等于 `109` |
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
| TypeScript / ESLint | 通过 | Workflow E2E 文件通过 `typecheck:test` 和 ESLint |
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
Domain/Service Workflow: 33 passed
Web Completion/Reconcile/Cron: 18 passed
CLI Completion Token Usage/Daemon Client: 4 passed
Deployment configuration: 13 passed
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
