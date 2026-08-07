import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  getDatabase,
  listWorkflowRunEventsSync,
  publishWorkflowVersionSync,
  readWorkflowRunSync,
  transitionWorkflowDefinitionStatusSync,
  transitionWorkflowRunSync,
} from "@dofe-agent/db";
import { rerunWorkflowRunSync } from "./materialization.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

interface Seed {
  workspaceId: string;
  workflowId: string;
  versionId: string;
}

/** 在独立工作区内种入一条带单个 employee_task 节点的已发布版本（active = V1）。 */
function seedWorkspace(versionId: string, graphJson: string): Seed {
  const suffix = Math.random().toString(36).slice(2, 10);
  const workspaceId = `workflow-rerun-${suffix}`;
  const workflowId = `workflow-definition-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  createWorkflowDefinitionSync({
    id: workflowId,
    workspaceId,
    name: "Rerun semantics",
    ownerUserId: "u1",
    createdBy: "u1",
    now,
  });
  publishWorkflowVersionSync({
    id: versionId,
    workspaceId,
    workflowId,
    graphJson,
    contentHash: `sha256:${suffix}`,
    publishedBy: "u1",
    now,
  });
  return { workspaceId, workflowId, versionId };
}

const GRAPH_V1 = JSON.stringify({
  schemaVersion: 1,
  nodes: [{ id: "n1", type: "employee_task", employeeId: "emp-a", config: {} }],
  edges: [],
});
// V2 图结构与 V1 不同（多一个节点），用于证明重跑不会被「当前激活版本」带偏。
const GRAPH_V2 = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    { id: "n1", type: "employee_task", employeeId: "emp-a", config: {} },
    { id: "n2", type: "employee_task", employeeId: "emp-b", config: {} },
  ],
  edges: [{ source: "n1", target: "n2" }],
});

function cleanup(workspaceId: string): void {
  getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
}

test("rerun pins the original version and reuses the input snapshot regardless of the current active version", {
  skip: !hasTestDatabase,
}, () => {
  const seed = seedWorkspace("wv-rerun-v1", GRAPH_V1);
  try {
    const now = "2026-08-07T01:00:00.000Z";
    // 原运行以 schedule 触发、携带业务输入；直接置为终态 failed。
    const original = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "schedule",
      triggerKey: `${seed.workflowId}:sched-original:${now}`,
      inputJson: JSON.stringify({ topic: "daily-brief" }),
    });
    transitionWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, from: ["created"], to: "failed", finishedAt: now, now });

    // 之后工作流重发布为 V2（active 指向 V2）。
    publishWorkflowVersionSync({
      id: "wv-rerun-v2",
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      graphJson: GRAPH_V2,
      contentHash: "sha256:rerun-v2",
      publishedBy: "u1",
      now,
    });

    const result = rerunWorkflowRunSync({
      workspaceId: seed.workspaceId,
      runId: original.id,
      idempotencyKey: "rerun-k1",
      createdBy: "u1",
      now,
    });
    const rerun = readWorkflowRunSync(result.runId, seed.workspaceId)!;
    // 重跑固定复用原版本（V1）与原输入快照，且以 manual 触发类型入队。
    assert.equal(rerun.versionId, seed.versionId, "rerun must pin the original version, not the current active one");
    assert.equal(rerun.inputJson, original.inputJson, "rerun must reuse the original input snapshot");
    assert.equal(rerun.triggerType, "manual");
    assert.equal(rerun.status, "queued");
    // 即便原运行是 schedule 触发，重跑也不受 manual-trigger 入口约束（放宽入口）。
    const events = listWorkflowRunEventsSync(seed.workspaceId, rerun.id, { limit: 50 });
    assert.ok(events.some((event) => event.type === "run.created"));
    assert.ok(events.some((event) => event.type === "trigger.fired"));
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("rerun is idempotent by idempotency key (trigger key)", {
  skip: !hasTestDatabase,
}, () => {
  const seed = seedWorkspace("wv-rerun-idem-v1", GRAPH_V1);
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const original = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `${seed.workflowId}:idem-original:${now}`,
      inputJson: "{}",
    });
    transitionWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, from: ["created"], to: "succeeded", finishedAt: now, now });

    const first = rerunWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, idempotencyKey: "idem-k1", createdBy: "u1", now });
    const second = rerunWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, idempotencyKey: "idem-k1", createdBy: "u1", now });
    assert.equal(second.runId, first.runId);
    assert.equal(second.created, false);
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("rerun rejects a run that has not reached a terminal state", {
  skip: !hasTestDatabase,
}, () => {
  const seed = seedWorkspace("wv-rerun-noterm-v1", GRAPH_V1);
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const running = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `${seed.workflowId}:noterm:${now}`,
      inputJson: "{}",
    });
    // 仍处于 created（未终结），重跑必须被拒绝。
    assert.throws(
      () => rerunWorkflowRunSync({ workspaceId: seed.workspaceId, runId: running.id, idempotencyKey: "noterm-k1", createdBy: "u1", now }),
      /workflow_run_not_terminal/,
    );
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("rerun is blocked when the workflow definition is paused or archived (紧急停用)", {
  skip: !hasTestDatabase,
}, () => {
  for (const blockedStatus of ["paused", "archived"] as const) {
    const seed = seedWorkspace(`wv-rerun-${blockedStatus}-v1`, GRAPH_V1);
    try {
      const now = "2026-08-07T01:00:00.000Z";
      const original = createWorkflowRunSync({
        workspaceId: seed.workspaceId,
        workflowId: seed.workflowId,
        versionId: seed.versionId,
        triggerType: "manual",
        triggerKey: `${seed.workflowId}:${blockedStatus}-original:${now}`,
        inputJson: "{}",
      });
      transitionWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, from: ["created"], to: "failed", finishedAt: now, now });

      // 将定义切换到 paused/archived：紧急停用后，已终结运行的重跑也必须被拒绝，
      // 否则暂停/归档无法真正阻止新的运行（业务架构文档:79）。
      const transitioned = transitionWorkflowDefinitionStatusSync({
        id: seed.workflowId,
        workspaceId: seed.workspaceId,
        from: ["published"],
        to: blockedStatus,
        now,
      });
      assert.ok(transitioned, `definition should transition to ${blockedStatus}`);

      assert.throws(
        () => rerunWorkflowRunSync({ workspaceId: seed.workspaceId, runId: original.id, idempotencyKey: `${blockedStatus}-k1`, createdBy: "u1", now }),
        /workflow_definition_not_runnable/,
      );
    } finally {
      cleanup(seed.workspaceId);
    }
  }
});
