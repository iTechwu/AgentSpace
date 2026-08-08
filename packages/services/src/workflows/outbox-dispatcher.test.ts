import assert from "node:assert/strict";
import test from "node:test";
import {
  claimWorkflowOutboxBatchSync,
  enqueueWorkflowOutboxSync,
  getDatabase,
  markWorkflowOutboxFailedSync,
} from "@dofe-agent/db";
import { computeWorkflowOutboxRetryAt, workflowOutboxErrorCode } from "./outbox-dispatcher.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
    || process.env.DOFE_AGENT_TEST_DATABASE_URL
    || process.env.DOFE_AGENT_PG_TEST_URL,
);

const WORKSPACE_PREFIX = "outbox-dispatcher-test";

function seedWorkspace(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const workspaceId = `${WORKSPACE_PREFIX}-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  getDatabase().prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  return workspaceId;
}

test("outbox retry uses bounded exponential backoff", () => {
  const now = "2026-08-07T00:00:00.000Z";
  assert.equal(computeWorkflowOutboxRetryAt(now, 1), "2026-08-07T00:00:05.000Z");
  assert.equal(computeWorkflowOutboxRetryAt(now, 20), "2026-08-07T00:15:00.000Z");
});

test("outbox persistence records only stable non-sensitive error codes", () => {
  assert.equal(workflowOutboxErrorCode(new Error("workflow_node_run_not_found")), "workflow_node_run_not_found");
  assert.equal(workflowOutboxErrorCode(new Error("provider failed with token=secret")), "workflow_outbox_dispatch_failed");
  // lease_conflict 必须原样保留为可识别码，dispatch 循环据此跳过而非当作普通失败。
  assert.equal(workflowOutboxErrorCode(new Error("workflow_outbox_lease_conflict")), "workflow_outbox_lease_conflict");
});

test("markWorkflowOutboxFailedSync re-throws lease_conflict when the worker lost the lease (Spec #5 trap)", {
  skip: !hasTestDatabase,
}, () => {
  // 证明修复前 catch 的危险点：若 catch 对一个已丢租约的条目调用 markWorkflowOutboxFailedSync，
  // 它会再次抛出 workflow_outbox_lease_conflict（WHERE locked_by=? 命中 0 行），逃出循环中断整批。
  // 修复后 dispatch 循环在调用 markWorkflowOutboxFailedSync 前先识别 lease_conflict 并 continue。
  const workspaceId = seedWorkspace();
  const now = "2026-08-07T01:00:00.000Z";
  const item = enqueueWorkflowOutboxSync({
    workspaceId,
    aggregateType: "workflow_node_run",
    aggregateId: "node-lease-trap",
    eventType: "workflow.node.ready",
    payloadJson: JSON.stringify({ nodeRunId: "node-lease-trap" }),
    now,
  });
  // W1 认领条目（locked_by=W1）。
  const claimed = claimWorkflowOutboxBatchSync({ workerId: "w1", now, limit: 10, leaseSeconds: 60, workspaceId });
  assert.equal(claimed.length, 1);

  // W2（未持租约）尝试 markFailed 必须抛 lease_conflict——这就是修复前 catch 内会逃出的错误。
  assert.throws(
    () => markWorkflowOutboxFailedSync({
      id: item.id,
      workerId: "w2",
      workspaceId,
      error: "workflow_outbox_dispatch_failed",
      nextAvailableAt: now,
      maxAttempts: 8,
    }),
    /workflow_outbox_lease_conflict/,
  );
});
