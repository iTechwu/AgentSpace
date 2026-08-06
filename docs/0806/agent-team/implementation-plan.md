# AI 员工通用自动化引擎 Implementation Plan

> 实施状态（2026-08-06）：阶段 1-4 的代码、部署契约、迁移预演、观测和发布门禁已落地；本地纯函数/前端/类型检查已通过。数据库集成和 Playwright E2E 仍待提供隔离 PostgreSQL 后执行，当前发布门禁保持 NO-GO。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AgentSpace 中交付可持久化、可调度、可审计的通用 Workflow Engine，并首期开放串行、并行汇聚、审批、定时和有限重试。

**Architecture:** Workflow Definition 与不可变 Version 描述 DAG，Workflow Run 与 Node Run 保存每次执行事实。独立 `apps/workflow-worker` 使用 PostgreSQL lease、outbox 和幂等键推进图；AI Task Node 继续委托现有 `agent_task_queue`、daemon 和 AgentRouter 执行。

**Tech Stack:** TypeScript、Node.js 24、PostgreSQL 16、Next.js 16、React 19、Vitest/Node Test、Playwright、Turbo、`@xyflow/react`。

---

## 1. 计划拆分

本规格跨四个可独立验收的子系统，必须按以下顺序实施：

| 阶段 | 详细计划 | 可独立验收结果 |
| --- | --- | --- |
| 1 | [plans/01-workflow-core.md](./plans/01-workflow-core.md) | 可创建、校验、发布不可变 Workflow；数据库和 workspace 隔离成立 |
| 2 | [plans/02-workflow-runtime.md](./plans/02-workflow-runtime.md) | 手动/定时运行，串行、并行 Join、重试、暂停、取消和审批可运行 |
| 3 | [plans/03-workflow-web.md](./plans/03-workflow-web.md) | 编排中心、统一创建向导、画布、运行详情、看板和日历入口可用 |
| 4 | [plans/04-workflow-migration-release.md](./plans/04-workflow-migration-release.md) | Legacy 迁移、双读切流、部署、观测、安全和发布门禁完成 |

每个阶段完成全部测试并提交后才能进入下一阶段。不得把 UI 合并到尚未通过并发/幂等测试的调度内核。

## 2. 总文件地图

```text
packages/domain/src/workflows.ts                 # 稳定类型、状态和图契约
packages/domain/src/workflows.test.ts            # DAG 与状态规则
packages/db/src/workflows/*.ts                   # 定义、版本、触发器、运行、节点、事件、outbox 仓储
packages/services/src/workflows/*.ts             # 校验、发布、调度、协调、输入、Join、重试、投影
apps/workflow-worker/*                           # 无状态 worker、健康检查和恢复循环
apps/web/features/workflows/*                    # Actions、loader、builder、run UI、客户端校验
apps/web/app/w/[workspaceSlug]/automations/*     # 编排中心路由
apps/web/app/api/cron/workflows/reconcile/*      # 受保护的低频恢复兜底
scripts/workflows/migrate-legacy.ts               # dry-run 和幂等迁移
deploy/self-hosted/*                             # 只增加应用 worker，不增加共享依赖服务
```

## 3. 跨阶段硬约束

1. 每个表和查询都以 `workspace_id` 为显式条件；任何 Artifact、员工、审批和队列引用都重新核对 workspace。
2. 已发布 Version 不更新；运行只绑定具体 Version，编辑始终生成新版本。
3. Scheduler/Coordinator 只通过数据库 lease、事务 outbox 和条件更新协调，不依赖进程内状态。
4. `agent_task_queue` 仍是 AI 节点唯一执行入口；Workflow Engine 不直接启动 Provider。
5. Workflow JSON 不保存 secret；节点只保存员工/Skill/Artifact 的稳定引用和安全摘要。
6. 首期输入映射是声明式路径引用，禁止 `eval`、shell、任意 JavaScript 和循环。
7. 根 `test` 脚本保持 `turbo run test --concurrency=2`；不得运行无约束的 `pnpm test`。
8. 部署不得创建 PostgreSQL、Redis 或 RabbitMQ；只连接 `../docker-helm.dofe.ai` 的共享服务。
9. 本工作站不启动或触发 Jenkins；实现止于本地验证和明确请求的提交/推送。

## 4. 阶段检查点

### Checkpoint A：核心契约

运行：

```bash
node --experimental-strip-types --test --test-concurrency=1 packages/domain/src/workflows.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/workflows.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/publishing.test.ts
pnpm run typecheck:deps
```

期望：全部 PASS；重复内容发布返回同一 hash 或明确冲突；跨 workspace 读取为 `null`/403 语义。

### Checkpoint B：运行内核

运行：

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/scheduler.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/coordinator.test.ts
pnpm --filter @dofe-agent/web run test -- app/api/daemon/routes.test.ts -t "workflow"
pnpm --filter @dofe-agent/web run test -- app/api/cron/workflows/reconcile/route.test.ts
```

期望：重复触发/完成事件不产生重复 Run 或下游任务；Join 不早于策略满足；暂停/取消不再 dispatch。

### Checkpoint C：Web 体验

运行：

```bash
pnpm --filter @dofe-agent/web run test -- features/workflows
pnpm --filter @dofe-agent/web run typecheck:test
pnpm --filter @dofe-agent/web run lint
pnpm --filter @dofe-agent/web run test:e2e -- workflows.spec.ts
```

期望：任务看板与日历进入同一向导；键盘可创建并发布 `A → (B ∥ C) → D`；刷新后 Run 状态一致。

### Checkpoint D：迁移与发布

运行：

```bash
node --env-file-if-exists=.env --experimental-strip-types scripts/workflows/migrate-legacy.ts --dry-run --workspace-id default
pnpm run typecheck
pnpm run lint:web
git diff --check
```

期望：dry-run 只输出统计和阻塞原因，不写库；部署清单没有新增数据库/消息中间件容器；feature flag 可回到 legacy 只读路径。

## 5. 完成定义

- 设计文档中的产品、业务、UI/UX、技术、前后端要求都能映射到至少一个阶段任务。
- 五个验收场景（每日简报、审批发布、失败恢复、错过/去重、权限撤销）均有自动化测试或明确的人工验证脚本。
- 调度 P95 ≤60 秒、投影可见性 ≤5 秒；并发测试没有重复 Run、重复队列任务或终态回退。
- 5-8 名目标用户测试完成率 ≥85%，SUS ≥68，P0/P1 可用性问题全部闭环。
- 每个独立任务验证后立即使用中文 commit message 提交；未经用户明确要求不 push。

## 6. 规格覆盖审计

| 规格要求 | 覆盖任务 |
| --- | --- |
| 版本化 Workflow、DAG、Join | Core 1-4；Runtime 1、4 |
| 手动/定时/事件触发与错过策略 | Runtime 2、7；Migration 1-2 |
| 现有 `agent_task_queue`、AgentRouter、daemon 复用 | Runtime 3、5 |
| 节点级重试、暂停、取消、审批、恢复 | Runtime 6-7 |
| 编排中心、统一向导、画布、运行详情 | Web 1-8 |
| 看板/日历双入口和移动端 | Web 8 |
| legacy ScheduledTask/AutomationRule 迁移与去重 | Migration 1-3 |
| workspace 隔离、secret 脱敏、审计和观测 | Core 2-4；Migration 5 |
| 无 PostgreSQL/Redis/RabbitMQ 应用内置服务 | Runtime 7；Migration 4 |
| E2E、性能、故障演练、发布门禁 | Migration 6 |
