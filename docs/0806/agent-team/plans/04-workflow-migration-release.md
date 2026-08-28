# Workflow Legacy 迁移、发布与验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; use executing-plans if executing inline). Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态说明（2026-08-06）：复选框是可复现施工步骤，不是完成台账；实际完成度与环境门禁见 [../07-规格实施覆盖矩阵.md](../07-规格实施覆盖矩阵.md)。

**Goal:** 把现有 ScheduledTask/AutomationRule 平滑迁移到 Workflow 投影，建立 feature flag、部署、观测、安全和最终验收门禁。

**Architecture:** 迁移脚本先 dry-run，再按 workspace 分阶段切流；旧对象保留 legacy source 映射和只读兼容，只有 Workflow Engine 拥有新 Trigger 的创建权。Worker 作为独立应用部署，Cron Route 只做恢复，不新增 PostgreSQL/Redis/RabbitMQ 服务。

**Tech Stack:** TypeScript、Node.js、PostgreSQL、Next.js、现有 deploy/self-hosted、系统服务、Playwright、Node Test。

---

## 文件结构

```text
scripts/workflows/migrate-legacy.ts
scripts/workflows/migrate-legacy.test.ts
packages/services/src/workflows/migration.ts
packages/services/src/workflows/feature-flags.ts
packages/services/src/workflows/observability.ts
packages/services/src/workflows/security.ts
deploy/workflow-worker/Dockerfile
deploy/workflow-worker/README.md
deploy/systemd/dofe-agent-workflow-worker.service
deploy/systemd/dofe-agent-workflow-worker.env.example
deploy/self-hosted/docker-compose.yml
apps/web/app/api/cron/workflows/reconcile/route.ts
apps/web/e2e/workflows-migration.spec.ts
docs/0806/agent-team/runbooks/workflow-operations.md
```

### Task 1: 实现 legacy dry-run 迁移

**Files:**
- Create: `packages/services/src/workflows/migration.ts`
- Create: `scripts/workflows/migrate-legacy.ts`
- Create: `scripts/workflows/migrate-legacy.test.ts`
- Modify: `packages/services/src/index.ts`

- [ ] **Step 1: 写迁移分类测试**

```ts
test("maps scheduled task with assignee to one-node workflow", () => {
  const result = planLegacyMigration({
    workspaceId: "default",
    scheduledTasks: [{ id: "st-1", title: "Morning brief", assignee: "Atlas", scheduledAt: "2026-08-07T01:00:00Z", repeat: "daily", status: "active" }],
    automationRules: [],
  });
  assert.deepEqual(result.actions, [{ sourceId: "st-1", kind: "create_workflow", employeeId: "emp-atlas", triggerType: "schedule" }]);
});

test("does not silently enable unassigned or dynamic legacy rules", () => {
  const result = planLegacyMigration({ scheduledTasks: [{ id: "st-2", title: "Unknown", scheduledAt: "2026-08-07T01:00:00Z", status: "active" }], automationRules: [{ id: "ar-1", trigger: { type: "message_received", config: {} }, actions: [{ type: "webhook", config: {} }] }] });
  assert.equal(result.actions.find((item) => item.sourceId === "st-2")?.kind, "disabled_draft");
  assert.equal(result.actions.find((item) => item.sourceId === "ar-1")?.kind, "legacy_adapter");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 scripts/workflows/migrate-legacy.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 dry-run planner 和 CLI**

```ts
export type LegacyMigrationAction =
  | { sourceId: string; kind: "create_workflow"; employeeId: string; triggerType: "schedule" }
  | { sourceId: string; kind: "disabled_draft"; reasonCode: string }
  | { sourceId: string; kind: "legacy_adapter"; reasonCode: string };

export function planLegacyMigration(input: LegacyMigrationInput): { actions: LegacyMigrationAction[]; counts: Record<string, number> };
export function applyLegacyMigrationSync(input: { workspaceId: string; plan: LegacyMigrationAction[]; dryRun: boolean }): MigrationReport;
```

CLI 支持 `--dry-run`、`--workspace-id`、`--apply`；默认 dry-run。输出 JSON/人类可读统计，失败记录 sourceId 和 reason，不输出 secret 或原始 webhook config。ScheduledTask 的 channel/repeat/cron 映射到 Trigger，任务描述成为员工节点 instruction；无 assignee 生成 paused draft。

- [ ] **Step 4: 运行 dry-run 测试**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 scripts/workflows/migrate-legacy.test.ts
node --env-file-if-exists=.env --experimental-strip-types scripts/workflows/migrate-legacy.ts --dry-run --workspace-id default
```

Expected: PASS；dry-run 不改变 `workflow_definition`/`workflow_trigger` 行数。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows scripts/workflows/migrate-legacy.ts scripts/workflows/migrate-legacy.test.ts
git commit -m "功能：新增定时与自动化迁移预演工具"
```

### Task 2: 建立 feature flag、双读和单一调度 owner

**Files:**
- Create: `packages/services/src/workflows/feature-flags.ts`
- Create: `packages/services/src/workflows/feature-flags.test.ts`
- Modify: `packages/services/src/schedules/schedules.ts:1-150`
- Modify: `packages/services/src/automations/automations.ts:1-150`
- Modify: `apps/web/features/calendar/actions.ts:1-80`
- Modify: `apps/web/features/automations/actions.ts:1-100`

- [ ] **Step 1: 写四态切流测试**

```ts
test("legacy-only, dual-read, engine and archived modes select one trigger owner", () => {
  expect(resolveTriggerOwner({ mode: "legacy_only" })).toBe("legacy");
  expect(resolveTriggerOwner({ mode: "dual_read" })).toBe("workflow");
  expect(resolveTriggerOwner({ mode: "workflow_engine" })).toBe("workflow");
  expect(resolveTriggerOwner({ mode: "legacy_archived" })).toBe("workflow");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/feature-flags.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 workspace 级 flag 和写路径转发**

```ts
export type WorkflowCutoverMode = "legacy_only" | "dual_read" | "workflow_engine" | "legacy_archived";
export function readWorkflowCutoverModeSync(workspaceId: string): WorkflowCutoverMode;
export function assertTriggerWriteOwnerSync(workspaceId: string, source: "calendar" | "automations" | "workflow"): void;
```

`dual_read` 只允许 Workflow Engine 创建/更新 trigger；Calendar/Automations action 转发到 Workflow service，同时保留 legacy read projection。`legacySourceId` 冲突返回 `workflow_trigger_duplicate`，不创建第二个 owner。

- [ ] **Step 4: 运行现有日历/自动化测试 + 新测试**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/calendar features/automations`

Expected: legacy 单测行为保持；新增 workflow flag 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows packages/services/src/schedules packages/services/src/automations apps/web/features/calendar/actions.ts apps/web/features/automations/actions.ts
git commit -m "功能：建立工作流切流与单一调度归属"
```

### Task 3: 实现双读投影和 legacy source 清理策略

**Files:**
- Modify: `apps/web/features/dashboard/data.ts:5450-5550`
- Modify: `apps/web/features/calendar/calendar-page-client.tsx:1-240`
- Modify: `apps/web/features/automations/automations-page-client.tsx:1-220`
- Create: `packages/services/src/workflows/migration.test.ts`

- [ ] **Step 1: 写投影一致性测试**

```ts
test("dual-read shows one workflow row for a migrated scheduled task", () => {
  seedLegacyScheduleAndWorkflowPair({ legacyId: "st-1", workflowId: "wf-1" });
  const calendar = getCalendarPageData("default");
  expect(calendar.scheduledTasks.filter((task) => task.legacySourceId === "st-1")).toHaveLength(1);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/dashboard/data.test.ts features/calendar/calendar-page-client.test.tsx`

Expected: FAIL，旧/新各显示一行或 DTO 缺字段。

- [ ] **Step 3: 实现 projection 去重**

新 projection 优先 Workflow record；legacy source 只提供历史 label 和编辑兼容入口。所有列表按 `workspaceId + legacySourceId` 去重，未映射 legacy 继续原样显示并带 `需迁移` 状态。删除只执行 archive/disable，不删除 Run/Artifact。

- [ ] **Step 4: 运行并提交**

Run: `pnpm --filter @dofe-agent/web exec vitest run features/dashboard/data.test.ts features/calendar features/automations`

Expected: PASS。

```bash
git add -A -- apps/web/features/dashboard/data.ts apps/web/features/calendar apps/web/features/automations packages/services/src/workflows
git commit -m "功能：统一工作流与旧规则的读取投影"
```

### Task 4: Worker 部署和恢复 Cron 配置

**Files:**
- Create: `deploy/workflow-worker/Dockerfile`
- Create: `deploy/workflow-worker/README.md`
- Create: `scripts/deployment/workflow-worker-contract.test.mjs`
- Create: `deploy/systemd/dofe-agent-workflow-worker.service`
- Create: `deploy/systemd/dofe-agent-workflow-worker.env.example`
- Modify: `deploy/self-hosted/docker-compose.yml`
- Modify: `deploy/self-hosted/README.md`

- [ ] **Step 1: 写部署静态约束测试**

```ts
test("workflow deployment references external dependencies only", () => {
  const files = readDeploymentFiles("deploy/workflow-worker", "deploy/self-hosted/docker-compose.yml");
  expect(files.join("\n")).not.toMatch(/postgres|redis|rabbitmq/i);
  expect(files.join("\n")).toMatch(/DATABASE_URL|WORKFLOW_WORKER/);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test scripts/deployment/workflow-worker-contract.test.mjs`

Expected: FAIL，测试文件或 worker deployment 不存在。

- [ ] **Step 3: 新增应用镜像/系统服务但不新增依赖服务**

Dockerfile 只复制 worker dist、domain/db/services runtime 和 package manifest；环境变量从外部注入 `DATABASE_URL`、`CRON_SECRET`、`WORKFLOW_WORKER_ID`、`WORKFLOW_WORKER_POLL_MS`。Compose 只增加 worker app service（如当前 self-hosted compose 架构要求），不增加数据库/Redis/RabbitMQ image、volume、init job 或 persistent volume。

systemd service 使用独立用户、Restart=on-failure、TimeoutStopSec 和环境文件；README 明确共享 PostgreSQL 来自 `../docker-helm.dofe.ai`。

- [ ] **Step 4: 运行静态检查**

Run:

```bash
node --test scripts/deployment/workflow-worker-contract.test.mjs
git diff --check
```

Expected: PASS；输出没有依赖服务定义。

- [ ] **Step 5: 提交**

```bash
git add -A -- deploy/workflow-worker deploy/systemd/dofe-agent-workflow-worker.service deploy/systemd/dofe-agent-workflow-worker.env.example deploy/self-hosted
git commit -m "部署：增加工作流 Worker 配置并复用共享依赖"
```

### Task 5: 安全、观测和运维 Runbook

**Files:**
- Create: `packages/services/src/workflows/security.ts`
- Create: `packages/services/src/workflows/observability.ts`
- Create: `packages/services/src/workflows/security.test.ts`
- Create: `docs/0806/agent-team/runbooks/workflow-operations.md`

- [ ] **Step 1: 写 security/metrics 测试**

```ts
test("workflow input redaction removes secret-like values from event summaries", () => {
  const result = redactWorkflowDiagnostic({ token: "secret-value", nested: { key: "secret-value" } }, ["secret-value"]);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("workflow metric labels never include user text", () => {
  const labels = buildWorkflowMetricLabels({ workspaceId: "ws-1", workflowId: "wf-1", nodeType: "employee_task", status: "failed" });
  assert.deepEqual(labels, { workspaceId: "ws-1", workflowId: "wf-1", nodeType: "employee_task", status: "failed" });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/security.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现脱敏、指标和日志关联**

只记录稳定 ID、状态码、计数和 duration；复用 daemon 的 redaction 规则，不把 graph input、secret、Provider raw message 放入 audit/event/metric label。输出 `workflow_trigger_lag_seconds`、`workflow_run_duration_seconds`、`workflow_node_failures_total`、`workflow_join_wait_seconds`、`workflow_manual_intervention_total`。

- [ ] **Step 4: 编写运维 Runbook**

Runbook 必须有：Worker 停止/恢复、outbox 堵塞、事件 sequence gap、重复 Run、Runtime 离线、预算暂停、按 workspace 回滚 flag、数据留存和 Legal Hold 检查。每个告警包含查询命令、只读诊断、恢复动作和禁止动作；不包含 Jenkins 步骤。

- [ ] **Step 5: 运行并提交**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/security.test.ts`

Expected: PASS。

```bash
git add -A -- packages/services/src/workflows/security.ts packages/services/src/workflows/observability.ts packages/services/src/workflows/security.test.ts docs/0806/agent-team/runbooks
git commit -m "安全：补齐工作流脱敏观测与运维手册"
```

### Task 6: E2E、性能、故障演练和发布门禁

**Files:**
- Create: `apps/web/e2e/workflows-migration.spec.ts`
- Create: `scripts/workflows/load-test.mjs`
- Create: `scripts/workflows/failure-drill.mjs`
- Create: `docs/0806/agent-team/release-checklist.md`

- [ ] **Step 1: 写五个验收场景 E2E**

覆盖：每日简报 `A → (B ∥ C) → D`、审批后发布、并行节点失败重试、Worker 停止后的 misfire/dedupe、运行前撤销 Runtime grant。每个测试只使用本地/测试管理员账号，断言 UI 状态、数据库事实和审计事件。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web run test:e2e -- workflows-migration.spec.ts`

Expected: FAIL，直到 Web/Runtime/迁移阶段接通。

- [ ] **Step 3: 实现 bounded load test 和 failure drill**

`load-test.mjs` 固定 workspace、1000 Trigger/100 Run/20 并发上限，输出调度延迟 P50/P95、重复 Run 数和 outbox backlog；不得无限创建任务。`failure-drill.mjs` 只在隔离测试库执行 Worker kill、重复 completion、sequence gap 和 Runtime offline 场景，结束后清理测试 workspace。

- [ ] **Step 4: 运行最终质量门禁**

Run:

```bash
pnpm run typecheck
pnpm run lint:web
pnpm --filter @dofe-agent/web run test:e2e -- workflows-migration.spec.ts
node scripts/workflows/load-test.mjs --workspace-id workflow-load-test --runs 100
node scripts/workflows/failure-drill.mjs --workspace-id workflow-drill-test
git diff --check
```

Expected：类型、lint、E2E 全部 PASS；P95 调度延迟 ≤60s；重复 Run/下游任务为 0；安全、部署和 feature flag 检查全通过。

- [ ] **Step 5: 填写 release checklist 并提交**

Checklist 必须记录迁移 dry-run 统计、数据库 schema 版本、Worker 镜像 digest、Cron secret、回滚 flag、可用性测试结果、未执行的 Jenkins/deployment 项和签字人。

```bash
git add -A -- apps/web/e2e scripts/workflows docs/0806/agent-team/release-checklist.md
git commit -m "验收：完成工作流迁移与发布门禁清单"
```
