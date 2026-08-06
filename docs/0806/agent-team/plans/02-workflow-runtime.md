# Workflow 调度执行与可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已发布 Workflow 能被手动、定时和受控事件可靠触发，并通过现有任务队列执行串行、并行 Join、审批、重试、暂停和取消。

**Architecture:** 无状态 Workflow Worker 通过 PostgreSQL lease 领取 Trigger/outbox；Run Coordinator 在事务中推进 Node Run。每个 employee_task 节点写入 `agent_task_queue`，daemon 完成/失败路由调用统一 completion adapter，重复事件保持幂等。

**Tech Stack:** TypeScript、Node.js worker、PostgreSQL、现有 `agent_task_queue`、AgentRouter、Next Route Handlers、Node Test、Vitest。

---

## 文件结构

```text
packages/db/src/workflows/runs.ts
packages/db/src/workflows/events.ts
packages/db/src/workflows/outbox.ts
packages/services/src/workflows/materialization.ts
packages/services/src/workflows/scheduler.ts
packages/services/src/workflows/coordinator.ts
packages/services/src/workflows/dispatcher.ts
packages/services/src/workflows/completion.ts
packages/services/src/workflows/retries.ts
packages/services/src/workflows/approvals.ts
apps/workflow-worker/package.json
apps/workflow-worker/src/index.ts
apps/workflow-worker/src/worker.ts
apps/web/app/api/cron/workflows/reconcile/route.ts
apps/web/app/api/daemon/tasks/[taskId]/complete/route.ts
apps/web/app/api/daemon/tasks/[taskId]/fail/route.ts
```

### Task 1: Run、Node Run、Event 和 Outbox 原子仓储

**Files:**
- Create: `packages/db/src/workflows/runs.ts`
- Create: `packages/db/src/workflows/events.ts`
- Create: `packages/db/src/workflows/outbox.ts`
- Create: `packages/db/src/workflows/runs.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: 写并发与幂等失败测试**

```ts
test("materializes one run for a duplicate trigger key", () => {
  const first = createWorkflowRunSync({ workspaceId: "default", workflowId: "wf-1", versionId: "v1", triggerType: "schedule", triggerKey: "wf-1:t1:2026-08-07T01:00:00Z", inputJson: "{}" });
  const second = createWorkflowRunSync({ workspaceId: "default", workflowId: "wf-1", versionId: "v1", triggerType: "schedule", triggerKey: "wf-1:t1:2026-08-07T01:00:00Z", inputJson: "{}" });
  assert.equal(second.id, first.id);
});

test("terminal node run cannot move backwards", () => {
  const node = seedNodeRun("succeeded");
  assert.equal(transitionWorkflowNodeRunSync({ workspaceId: "default", nodeRunId: node.id, from: ["succeeded"], to: "running" }), null);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/runs.test.ts`

Expected: FAIL，Run 仓储 API 未定义。

- [ ] **Step 3: 实现条件更新、事件 sequence 和 outbox lease**

```ts
export function createWorkflowRunSync(input: CreateWorkflowRunInput): WorkflowRunRecord;
export function materializeWorkflowNodeRunsSync(input: MaterializeNodeRunsInput): WorkflowNodeRunRecord[];
export function transitionWorkflowRunSync(input: TransitionWorkflowRunInput): WorkflowRunRecord | null;
export function transitionWorkflowNodeRunSync(input: TransitionWorkflowNodeRunInput): WorkflowNodeRunRecord | null;
export function appendWorkflowRunEventSync(input: AppendWorkflowRunEventInput): WorkflowRunEventRecord;
export function enqueueWorkflowOutboxSync(input: EnqueueWorkflowOutboxInput): WorkflowOutboxRecord;
export function claimWorkflowOutboxBatchSync(input: { workerId: string; now: string; limit: number; leaseSeconds: number }): WorkflowOutboxRecord[];
export function markWorkflowOutboxPublishedSync(id: string, workerId: string, workspaceId: string): void;
```

`createWorkflowRunSync` 使用 `INSERT ... ON CONFLICT(workspace_id, trigger_key) DO UPDATE SET updated_at = workflow_run.updated_at RETURNING *`；sequence 在锁定 Run 行后递增。所有 transition 用 `status IN (...)` 条件，终态不回退。

- [ ] **Step 4: 运行测试/类型检查**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/workflows/runs.test.ts
pnpm --filter @dofe-agent/db run types
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/db/src/workflows packages/db/src/index.ts
git commit -m "功能：实现工作流运行与事件仓储"
```

### Task 2: 实现 Trigger claim、misfire 和 Run 物化

**Files:**
- Create: `packages/services/src/workflows/materialization.ts`
- Create: `packages/services/src/workflows/scheduler.ts`
- Create: `packages/services/src/workflows/scheduler.test.ts`
- Modify: `packages/services/src/index.ts`

- [ ] **Step 1: 写重复 tick 和错过策略测试**

```ts
test("two scheduler ticks create one run and advance next fire time once", () => {
  seedDailyTrigger({ id: "trigger-1", nextFireAt: "2026-08-07T01:00:00Z", timezone: "Asia/Shanghai" });
  const first = tickWorkflowSchedulerSync({ now: "2026-08-07T01:00:30Z", workerId: "w1", limit: 10 });
  const second = tickWorkflowSchedulerSync({ now: "2026-08-07T01:00:30Z", workerId: "w2", limit: 10 });
  assert.equal(first.createdRunIds.length, 1);
  assert.deepEqual(second.createdRunIds, []);
  assert.equal(listWorkflowRunsSync("default").length, 1);
});

test("skip misfire does not backfill historical occurrences", () => {
  seedDailyTrigger({ nextFireAt: "2026-08-01T01:00:00Z", misfirePolicy: "skip" });
  const result = tickWorkflowSchedulerSync({ now: "2026-08-07T01:00:00Z", workerId: "w1", limit: 10 });
  assert.deepEqual(result.createdRunIds, []);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/scheduler.test.ts`

Expected: FAIL，scheduler 未定义。

- [ ] **Step 3: 实现 Scheduler Service**

```ts
export interface WorkflowSchedulerTickResult {
  claimedTriggerIds: string[];
  createdRunIds: string[];
  deduplicatedTriggerIds: string[];
  misfiredTriggerIds: string[];
}

export function tickWorkflowSchedulerSync(input: {
  now: string;
  workerId: string;
  limit: number;
}): WorkflowSchedulerTickResult;
```

在 DB 层增加 `claimDueWorkflowTriggersSync`，使用 `FOR UPDATE SKIP LOCKED`、`lease_owner`、`lease_expires_at`。Service 生成 `triggerKey = workflowId:triggerId:scheduledAt`，事务内创建 Run、Node Run、`run.created` 事件和 ready outbox，再计算下一次 UTC 时间。时区/DST 使用明确库或 Temporal API；不得用字符串加 24 小时实现每日计划。

- [ ] **Step 4: 运行测试并提交**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/scheduler.test.ts
pnpm --filter @dofe-agent/services run types
```

Expected: PASS。

```bash
git add -A -- packages/db/src/workflows packages/services/src/workflows packages/services/src/index.ts
git commit -m "功能：实现工作流定时触发与运行物化"
```

### Task 3: 实现 Dispatcher 和现有任务队列关联

**Files:**
- Modify: `packages/db/src/types.ts:430-495`
- Modify: `packages/db/src/task-queue.ts:20-125`
- Modify: `packages/db/src/task-queue.test.ts:91-159`
- Create: `packages/services/src/workflows/dispatcher.ts`
- Create: `packages/services/src/workflows/dispatcher.test.ts`

- [ ] **Step 1: 写 workflow metadata 和一次投递测试**

```ts
test("dispatches a ready employee node exactly once", () => {
  const nodeRun = seedReadyEmployeeNodeRun();
  const first = dispatchReadyWorkflowNodeSync({ workspaceId: "default", nodeRunId: nodeRun.id });
  const second = dispatchReadyWorkflowNodeSync({ workspaceId: "default", nodeRunId: nodeRun.id });
  assert.ok(first.taskQueueId);
  assert.equal(second.taskQueueId, first.taskQueueId);
  const task = readQueuedTaskSync(first.taskQueueId!);
  const payload = JSON.parse(task!.inputJson);
  assert.deepEqual(payload.workflow, { runId: nodeRun.runId, nodeRunId: nodeRun.id, nodeId: nodeRun.nodeId, attempt: 1 });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/dispatcher.test.ts`

Expected: FAIL。

- [ ] **Step 3: 扩展 EnqueueTaskInput 并实现 Dispatcher**

```ts
export interface WorkflowTaskMetadata {
  workflowId: string;
  workflowVersionId: string;
  workflowRunId: string;
  workflowNodeId: string;
  workflowNodeRunId: string;
  attempt: number;
  artifactRefs: string[];
  outputSchema?: Record<string, unknown>;
}

// EnqueueTaskInput 增加：
workflow?: WorkflowTaskMetadata;
```

`enqueueNativeTaskSync` 把 metadata 放入 `input_json.workflow`，不新增一组可漂移的 queue 列。Dispatcher 先用条件更新 `ready → queued` 并写 task_queue_id；若 queue 创建失败则原子恢复为 `ready` 并增加 outbox attempt。

- [ ] **Step 4: 运行相关测试**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/db/src/task-queue.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/dispatcher.test.ts
```

Expected: PASS；legacy payload 不变。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/db/src/types.ts packages/db/src/task-queue.ts packages/db/src/task-queue.test.ts packages/services/src/workflows
git commit -m "功能：将工作流节点接入任务队列"
```

### Task 4: 实现串行、并行与 Join Coordinator

**Files:**
- Create: `packages/services/src/workflows/inputs.ts`
- Create: `packages/services/src/workflows/coordinator.ts`
- Create: `packages/services/src/workflows/coordinator.test.ts`

- [ ] **Step 1: 写 `A → (B ∥ C) → Join → D` 状态测试**

```ts
test("activates parallel nodes and waits for all-success join", () => {
  const run = seedRun(PARALLEL_GRAPH);
  completeWorkflowNodeSync({ workspaceId: "default", nodeRunId: node(run, "a").id, taskQueueId: "q-a", output: { report: "artifact://report" } });
  assert.equal(node(run, "b").status, "ready");
  assert.equal(node(run, "c").status, "ready");
  completeWorkflowNodeSync({ workspaceId: "default", nodeRunId: node(run, "b").id, taskQueueId: "q-b", output: { analysis: "ok" } });
  assert.equal(node(run, "join").status, "pending");
  completeWorkflowNodeSync({ workspaceId: "default", nodeRunId: node(run, "c").id, taskQueueId: "q-c", output: { audit: "ok" } });
  assert.equal(node(run, "join").status, "succeeded");
  assert.equal(node(run, "d").status, "ready");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/coordinator.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现声明式输入映射和推进事务**

```ts
export function resolveWorkflowNodeInput(input: {
  runInput: Record<string, unknown>;
  nodeConfig: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
}): Record<string, unknown>;

export function completeWorkflowNodeSync(input: {
  workspaceId: string;
  nodeRunId: string;
  taskQueueId: string;
  output: Record<string, unknown>;
  artifactManifest?: unknown[];
}): WorkflowRunRecord;
```

只解析 `${run.input.x}`、`${nodes.<id>.output.x}`、`${join.outputs}`；未知路径返回 `workflow_input_reference_missing`，禁止 `eval`。推进时锁 Run，验证 task_queue_id 和活动 attempt，写终态、事件和下游 ready outbox；Join `all_success` 等待全部成功，`allow_partial` 至少一个成功且全部上游终态。

- [ ] **Step 4: 增加失败/重复事件断言并运行**

补充：重复 completion 不重复推进；上游失败使 all_success Join 失败；跨 workspace task_queue_id 被拒绝。

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/coordinator.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows
git commit -m "功能：实现工作流并行汇聚与图推进"
```

### Task 5: 接入 daemon 完成/失败事实事件

**Files:**
- Create: `packages/services/src/workflows/completion.ts`
- Modify: `apps/web/app/api/daemon/tasks/[taskId]/complete/route.ts:175-260`
- Modify: `apps/web/app/api/daemon/tasks/[taskId]/fail/route.ts:43-83`
- Modify: `apps/web/app/api/daemon/routes.test.ts`

- [ ] **Step 1: 写路由集成失败测试**

```ts
it("advances workflow after a workflow task completes", async () => {
  const seeded = seedWorkflowDaemonTask();
  const response = await completeTask(seeded.taskId, { outputText: "done" });
  expect(response.status).toBe(200);
  expect(readWorkflowNodeRunSync(seeded.nodeRunId, seeded.workspaceId)?.status).toBe("succeeded");
  expect(readWorkflowNodeRunSync(seeded.nextNodeRunId, seeded.workspaceId)?.status).toBe("ready");
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @dofe-agent/web run test -- app/api/daemon/routes.test.ts -t "advances workflow"`

Expected: FAIL，Node Run 保持 queued/running。

- [ ] **Step 3: 实现统一 completion adapter**

```ts
export function completeWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  outputText: string;
  artifactManifest: unknown[];
}): { linked: boolean; runId?: string };

export function failWorkflowTaskIfLinkedSync(input: {
  workspaceId: string;
  taskQueueId: string;
  errorCode?: string;
  errorText: string;
}): { linked: boolean; retryScheduled: boolean; runId?: string };
```

在原路由完成持久化输出/队列终态后调用 adapter；失败路由在 `failQueuedTaskSync` 后调用。Adapter 通过 task_queue_id 反查 Node Run 并核对 workspace，legacy 任务返回 `{ linked:false }`，不改变原行为。

- [ ] **Step 4: 运行 complete/fail/legacy 测试**

Run: `pnpm --filter @dofe-agent/web run test -- app/api/daemon/routes.test.ts -t "workflow|legacy completion"`

Expected: PASS；重复 daemon completion 返回成功且不重复下游。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows/completion.ts apps/web/app/api/daemon apps/web/app/api/daemon/routes.test.ts
git commit -m "功能：接入工作流节点完成与失败事件"
```

### Task 6: 实现重试、暂停、取消、审批和恢复

**Files:**
- Create: `packages/services/src/workflows/retries.ts`
- Create: `packages/services/src/workflows/approvals.ts`
- Create: `packages/services/src/workflows/recovery.ts`
- Create: `packages/services/src/workflows/control.test.ts`
- Modify: `apps/web/features/approvals/actions.ts:38-61`

- [ ] **Step 1: 写控制状态失败测试**

```ts
test("retry preserves successful siblings and increments attempt", () => {
  const run = seedPartiallyFailedParallelRun();
  retryWorkflowNodeSync({ workspaceId: "default", runId: run.id, nodeId: "audit", actorUserId: "owner", reason: "transient provider error" });
  assert.equal(node(run, "analysis").status, "succeeded");
  assert.equal(node(run, "audit").status, "retry_wait");
  assert.equal(node(run, "audit").attemptCount, 2);
});

test("cancelled runs never dispatch ready nodes", () => {
  const run = seedRunWithReadyNode();
  cancelWorkflowRunSync({ workspaceId: "default", runId: run.id, actorUserId: "owner", reason: "no longer needed" });
  assert.equal(dispatchWorkflowOutboxBatchSync({ workerId: "w1", limit: 10 }).dispatchedTaskIds.length, 0);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/control.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现控制 API 和审批桥接**

```ts
export function retryWorkflowNodeSync(input: RetryWorkflowNodeInput): WorkflowNodeRunRecord;
export function pauseWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord;
export function resumeWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord;
export function cancelWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord;
export function createWorkflowApprovalSync(input: CreateWorkflowApprovalInput): ApprovalRequest;
export function continueWorkflowAfterApprovalSync(input: { workspaceId: string; approvalId: string; decision: "approved" | "rejected"; actorUserId: string }): WorkflowRunRecord;
```

重试使用指数退避但上限明确；取消 best-effort 调用现有 queue cancel，已完成节点不回退。审批 action 完成现有 `reviewApprovalSync` 后调用桥接；批准使节点 succeeded 并推进，拒绝使节点/Run failed。

- [ ] **Step 4: 实现 stale lease 恢复并运行测试**

`recoverStaleWorkflowWorkSync({ now, workerId, limit })` 恢复过期 Trigger/outbox lease、将无活动 task 且 lease 过期的 queued Node 回到 ready，超过恢复次数标记 failed 并通知负责人。

Run: `node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/control.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- packages/services/src/workflows apps/web/features/approvals/actions.ts
git commit -m "功能：完善工作流控制审批与故障恢复"
```

### Task 7: 新增无状态 Worker 和 Cron 恢复入口

**Files:**
- Create: `apps/workflow-worker/package.json`
- Create: `apps/workflow-worker/tsconfig.json`
- Create: `apps/workflow-worker/src/worker.ts`
- Create: `apps/workflow-worker/src/index.ts`
- Create: `apps/workflow-worker/src/worker.test.ts`
- Create: `apps/web/app/api/cron/workflows/reconcile/route.ts`
- Create: `apps/web/app/api/cron/workflows/reconcile/route.test.ts`

- [ ] **Step 1: 写 Worker 单轮执行和 Cron fail-closed 测试**

```ts
test("worker tick runs scheduler, outbox and recovery with bounded batches", async () => {
  const calls: string[] = [];
  await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, services: fakeServices(calls) });
  assert.deepEqual(calls, ["scheduler:20", "outbox:20", "recovery:20"]);
});

it("cron reconcile fails closed without CRON_SECRET", async () => {
  delete process.env.CRON_SECRET;
  const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile"));
  expect(response.status).toBe(500);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 apps/workflow-worker/src/worker.test.ts
pnpm --filter @dofe-agent/web run test -- app/api/cron/workflows/reconcile/route.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 Worker 循环**

`apps/workflow-worker/package.json` 使用以下最小契约：

```json
{
  "name": "@dofe-agent/workflow-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --env-file-if-exists=../../.env --experimental-strip-types --test --test-concurrency=1 src/*.test.ts",
    "types": "../../apps/web/node_modules/.bin/tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@dofe-agent/db": "workspace:*", "@dofe-agent/services": "workspace:*" }
}
```

```ts
export async function runWorkflowWorkerTick(input: {
  workerId: string;
  batchSize: number;
  services?: WorkflowWorkerServices;
}): Promise<{ scheduled: number; dispatched: number; recovered: number }>;
```

`index.ts` 读取 `WORKFLOW_WORKER_POLL_MS`（默认 1000）、`WORKFLOW_WORKER_BATCH_SIZE`（默认 20）和唯一 workerId；每轮有超时和结构化错误日志，SIGTERM 停止领取新工作并等待当前 tick。不得使用无界 `Promise.all`。

- [ ] **Step 4: 实现 Cron reconcile**

复用 `data-protection-health` 的 `Authorization: Bearer ${CRON_SECRET}` fail-closed 模式；route 只调用 `recoverStaleWorkflowWorkSync` 和一次 bounded tick，返回计数，不暴露 Run 输入/错误详情。

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 apps/workflow-worker/src/worker.test.ts
pnpm --filter @dofe-agent/web run test -- app/api/cron/workflows/reconcile/route.test.ts
pnpm run typecheck:deps
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A -- apps/workflow-worker apps/web/app/api/cron/workflows packages/services/src/workflows package.json pnpm-lock.yaml
git commit -m "功能：新增工作流调度进程与恢复入口"
```

### Task 8: 运行内核阶段回归

**Files:**
- Modify: `package.json`
- Modify: `turbo.json`

- [ ] **Step 1: 为 worker 增加受限 test/typecheck scripts 并纳入依赖图**

`apps/workflow-worker/package.json` 的 test 必须使用 `--test-concurrency=1`；根 `test` 保持 `turbo run test --concurrency=2` 不变。

- [ ] **Step 2: 运行阶段测试**

Run:

```bash
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 packages/services/src/workflows/*.test.ts
node --env-file-if-exists=.env --experimental-strip-types --test --test-concurrency=1 apps/workflow-worker/src/*.test.ts
pnpm --filter @dofe-agent/web run test -- app/api/daemon/routes.test.ts -t "workflow"
pnpm --filter @dofe-agent/web run test -- app/api/cron/workflows/reconcile/route.test.ts
pnpm run typecheck:deps
```

Expected: 全部 PASS。

- [ ] **Step 3: 检查并提交**

```bash
git diff --check
git add -A -- package.json turbo.json apps/workflow-worker packages/services/src/workflows apps/web/app/api
git commit -m "测试：完成工作流运行内核回归验证"
```
