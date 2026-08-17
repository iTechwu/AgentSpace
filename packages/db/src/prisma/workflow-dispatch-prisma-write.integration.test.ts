import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDatabase } from "../database.ts";
import { registerDaemonRuntimesSync } from "../daemons.ts";
import { bindEmployeeRuntimeSync } from "../employee-bindings.ts";
import { createStoredEmployeeSync } from "../workspace-employees.ts";
import { createWorkspaceSync, hardDeleteWorkspaceSync } from "../workspaces.ts";
import { createWorkflowDefinitionSync, publishWorkflowVersionSync } from "../workflows/definitions.ts";
import {
  createWorkflowRunSync,
  materializeWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  transitionWorkflowNodeRunSync,
} from "../workflows/runs.ts";
import { enqueueWorkflowOutboxSync } from "../workflows/outbox.ts";
import { disconnectDofePrismaClient, getDofePrismaClient } from "./prisma-client.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";
import {
  dispatchWorkflowNodeFromOutboxPrisma,
  dispatchWorkflowNodePrisma,
  type DispatchWorkflowNodePrismaInput,
} from "./workflow-dispatch-prisma-write.ts";

// 真实 PostgreSQL 集成测试（ADR docs/0816/06 第 4 步补充）：两 worker 并发 claim、
// outbox 发布失败时业务写整体回滚、同 run 双节点并发派发。40001 串行化冲突在并发
// 用例中自然出现并经 retrySerializableTransaction 收敛；40P01/40001 错误码分类无法
// 从该 API 边界真实舞台化（事务内无显式反向行锁），由下方 mock 分类测试覆盖。

const SEED_NOW = "2026-08-01T00:00:00.000Z";
const DISPATCH_NOW = "2026-08-17T00:00:00.000Z";

interface DispatchFixture {
  workspaceId: string;
  runId: string;
  nodeRunIds: string[];
  outboxId: string;
  queueIds: string[];
  baselineRunEvents: number;
}

function countRows(sql: string, ...params: string[]): number {
  return (getDatabase().prepare(sql).get(...params) as { count: number }).count;
}

function seedDispatchFixture(nodeCount = 1): DispatchFixture {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `workspace-dispatch-it-${suffix}`;
  const employeeName = `Dispatch IT ${suffix}`;
  const employeeId = `employee-${suffix}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Dispatch IT Workspace ${suffix}`,
    createdBy: "dispatch-it-test",
  });
  createStoredEmployeeSync({
    id: employeeId,
    name: employeeName,
    role: "Agent",
    origin: "manual",
    summary: "Dispatcher integration fixture",
    traits: [],
    fit: "Ready",
    status: "active",
    instructions: "",
    skillIds: [],
    channels: [],
  }, workspaceId);
  const runtime = registerDaemonRuntimesSync({
    daemonKey: `dispatch-it-${suffix}`,
    deviceName: `Dispatch IT Device ${suffix}`,
    workspaceId,
    runtimes: [{ provider: "codex", name: `Dispatch IT Runtime ${suffix}`, version: "test" }],
  }).runtimes[0]!;
  bindEmployeeRuntimeSync({ workspaceId, employeeName, runtimeId: runtime.id });

  const definition = createWorkflowDefinitionSync({
    id: `workflow-dispatch-it-${suffix}`,
    workspaceId,
    name: "Dispatch IT",
    ownerUserId: "dispatch-it-test",
    createdBy: "dispatch-it-test",
  });
  const version = publishWorkflowVersionSync({
    id: `version-dispatch-it-${suffix}`,
    workspaceId,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: `sha256:${suffix}`,
    publishedBy: "dispatch-it-test",
  });
  const run = createWorkflowRunSync({
    workspaceId,
    workflowId: definition.id,
    versionId: version.id,
    triggerType: "manual",
    triggerKey: `dispatch-it:${suffix}`,
    inputJson: "{}",
    now: SEED_NOW,
  });
  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId,
    runId: run.id,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      nodeId: `node-${suffix}-${index}`,
      nodeType: "employee_task",
      employeeId,
    })),
  });
  const nodeRunIds: string[] = [];
  for (const node of nodes) {
    transitionWorkflowNodeRunSync({
      workspaceId,
      nodeRunId: node.id,
      from: ["pending"],
      to: "ready",
      now: SEED_NOW,
    });
    nodeRunIds.push(node.id);
  }
  const outbox = enqueueWorkflowOutboxSync({
    workspaceId,
    aggregateType: "workflow_node_run",
    aggregateId: nodeRunIds[0]!,
    eventType: "workflow.node.ready",
    payloadJson: JSON.stringify({ nodeRunId: nodeRunIds[0] }),
    now: SEED_NOW,
  });
  return {
    workspaceId,
    runId: run.id,
    nodeRunIds,
    outboxId: outbox.id,
    queueIds: nodeRunIds.map((nodeRunId) => `queue-workflow-${nodeRunId}`),
    baselineRunEvents: countRows(
      "SELECT COUNT(*)::integer AS count FROM workflow_run_event WHERE run_id = ?",
      run.id,
    ),
  };
}

function dispatchInput(fixture: DispatchFixture, nodeIndex = 0): DispatchWorkflowNodePrismaInput {
  return {
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    nodeRunId: fixture.nodeRunIds[nodeIndex]!,
    employeeId: fixture.nodeRunIds[nodeIndex] ? `employee-${fixture.workspaceId.slice("workspace-dispatch-it-".length)}` : "",
    title: "Dispatch integration task",
    inputJson: { brief: "integration" },
    workflowMetadata: {
      workflowRunId: fixture.runId,
      workflowNodeRunId: fixture.nodeRunIds[nodeIndex]!,
      attempt: 1,
    },
    maxConcurrency: 4,
    now: DISPATCH_NOW,
  };
}

async function cleanupDispatchFixture(workspaceId: string): Promise<void> {
  await disconnectDofePrismaClient();
  hardDeleteWorkspaceSync(workspaceId);
}

test("two outbox workers race one node: exactly one claim, lease conflict for the loser, no duplicate side effects", async () => {
  const fixture = seedDispatchFixture();
  try {
    const base = dispatchInput(fixture);
    const winner = await Promise.allSettled([
      dispatchWorkflowNodeFromOutboxPrisma({ ...base, outbox: { id: fixture.outboxId, workerId: "worker-a" } }),
      dispatchWorkflowNodeFromOutboxPrisma({ ...base, outbox: { id: fixture.outboxId, workerId: "worker-b" } }),
    ]);
    const fulfilled = winner.filter((entry) => entry.status === "fulfilled");
    const rejected = winner.filter((entry) => entry.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one worker may claim the node");
    assert.equal(fulfilled[0]!.value.reason, "claimed");
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /workflow_outbox_lease_conflict/);

    const outbox = getDatabase().prepare(
      "SELECT status, attempts, locked_by FROM workflow_outbox WHERE id = ?",
    ).get(fixture.outboxId) as { status: string; attempts: number; locked_by: string | null };
    assert.equal(outbox.status, "published");
    assert.equal(outbox.attempts, 1, "the losing worker must not double-increment attempts");
    assert.equal(outbox.locked_by, null);

    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_task_queue WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 1);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_router_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 1);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM task_execution_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 1);
    const node = readWorkflowNodeRunSync(fixture.nodeRunIds[0]!, fixture.workspaceId)!;
    assert.equal(node.status, "queued");
    assert.equal(node.taskQueueId, fixture.queueIds[0]);
    const runEvents = getDatabase().prepare(
      "SELECT type FROM workflow_run_event WHERE run_id = ? ORDER BY sequence",
    ).all(fixture.runId) as Array<{ type: string }>;
    assert.deepEqual(
      runEvents.slice(fixture.baselineRunEvents).map((event) => event.type),
      ["node.queued"],
    );
  } finally {
    await cleanupDispatchFixture(fixture.workspaceId);
  }
});

test("a lost outbox lease at publish time rolls back the node claim, queue row and every event", async () => {
  const fixture = seedDispatchFixture();
  try {
    getDatabase().prepare(
      "UPDATE workflow_outbox SET status = 'published', published_at = ?, locked_at = NULL, locked_by = NULL WHERE id = ?",
    ).run(SEED_NOW, fixture.outboxId);

    // 末段失败注入：业务写（node claim、queue、双事件、run event）全部执行后，
    // publishOutboxInTransaction 的 pending+lockedBy CAS 命中 0 行 → 整体回滚。
    await assert.rejects(
      () => dispatchWorkflowNodePrisma({
        ...dispatchInput(fixture),
        outbox: { id: fixture.outboxId, workerId: "worker-a" },
      }),
      /workflow_outbox_lease_conflict/,
    );

    const node = readWorkflowNodeRunSync(fixture.nodeRunIds[0]!, fixture.workspaceId)!;
    assert.equal(node.status, "ready", "the node claim must roll back with the publish failure");
    assert.equal(node.taskQueueId ?? null, null);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_task_queue WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 0);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_router_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 0);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM task_execution_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 0);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM workflow_run_event WHERE run_id = ?",
      fixture.runId,
    ), fixture.baselineRunEvents);
    const outbox = getDatabase().prepare(
      "SELECT status, attempts FROM workflow_outbox WHERE id = ?",
    ).get(fixture.outboxId) as { status: string; attempts: number };
    assert.equal(outbox.status, "published");
    assert.equal(outbox.attempts, 0);
  } finally {
    await cleanupDispatchFixture(fixture.workspaceId);
  }
});

test("two ready nodes on one run dispatch concurrently under the run row lock without deadlock", async () => {
  const fixture = seedDispatchFixture(2);
  try {
    const results = await Promise.all([
      dispatchWorkflowNodePrisma(dispatchInput(fixture, 0)),
      dispatchWorkflowNodePrisma(dispatchInput(fixture, 1)),
    ]);

    assert.deepEqual(results.map((result) => result.reason), ["claimed", "claimed"]);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_task_queue WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 2);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM agent_router_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 2);
    assert.equal(countRows(
      "SELECT COUNT(*)::integer AS count FROM task_execution_event WHERE workspace_id = ?",
      fixture.workspaceId,
    ), 2);
    for (const [index, nodeRunId] of fixture.nodeRunIds.entries()) {
      const node = readWorkflowNodeRunSync(nodeRunId, fixture.workspaceId)!;
      assert.equal(node.status, "queued");
      assert.equal(node.taskQueueId, fixture.queueIds[index]);
    }
  } finally {
    await cleanupDispatchFixture(fixture.workspaceId);
  }
});

test("serializable conflict classification covers deadlock 40P01 and SQLSTATE 40001", async () => {
  for (const code of ["40P01", "40001"]) {
    let attempts = 0;
    const tx = {
      $queryRaw: async () => [{ id: "run-1", status: "running" }],
      workflowNodeRun: {
        findFirst: async () => ({ id: "node-run-1", runId: "run-1", status: "queued", taskQueueId: "queue-workflow-node-run-1" }),
      },
    };
    const client = {
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("deadlock detected"), { code });
        return callback(tx);
      },
    };
    const result = await dispatchWorkflowNodePrisma({
      workspaceId: "workspace-1",
      runId: "run-1",
      nodeRunId: "node-run-1",
      employeeId: "employee-1",
      title: "Retry classification",
      inputJson: {},
      workflowMetadata: {},
      maxConcurrency: 4,
      now: DISPATCH_NOW,
    }, client as never);
    assert.equal(attempts, 2);
    assert.equal(result.reason, "already_queued");
  }
});

test("real PostgreSQL deadlock retries one of two opposing Serializable transactions", async () => {
  const first = createWorkspaceSync({
    id: `workspace-deadlock-a-${Math.random().toString(36).slice(2, 10)}`,
    slug: `workspace-deadlock-a-${Math.random().toString(36).slice(2, 10)}`,
    name: "Deadlock A",
    createdBy: "dispatch-it-test",
  });
  const second = createWorkspaceSync({
    id: `workspace-deadlock-b-${Math.random().toString(36).slice(2, 10)}`,
    slug: `workspace-deadlock-b-${Math.random().toString(36).slice(2, 10)}`,
    name: "Deadlock B",
    createdBy: "dispatch-it-test",
  });
  let arrived = 0;
  let releaseFirstAttempt: (() => void) | undefined;
  const firstAttemptBarrier = new Promise<void>((resolve) => { releaseFirstAttempt = resolve; });
  let firstAttempts = 0;
  let secondAttempts = 0;
  const client = getDofePrismaClient();

  const lock = (left: string, right: string, increment: () => number) => retryPrismaTransaction(() => client.$transaction(async (tx) => {
    const attempt = increment();
    await tx.$queryRaw(Prisma.sql`SELECT id FROM workspace WHERE id = ${left} FOR UPDATE`);
    if (attempt === 1) {
      arrived += 1;
      if (arrived === 2) releaseFirstAttempt?.();
      await firstAttemptBarrier;
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM workspace WHERE id = ${right} FOR UPDATE`);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

  try {
    await Promise.all([
      lock(first.id, second.id, () => ++firstAttempts),
      lock(second.id, first.id, () => ++secondAttempts),
    ]);
    assert.ok(firstAttempts > 1 || secondAttempts > 1, "one transaction must retry after the real deadlock");
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(first.id);
    hardDeleteWorkspaceSync(second.id);
  }
});
