import assert from "node:assert/strict";
import test from "node:test";
import {
  computeWorkflowQueueRetryAt,
  dispatchReadyWorkflowNodeSync,
  resolveWorkflowMaxConcurrency,
} from "./dispatcher.ts";

test("dispatcher concurrency defaults are bounded", () => {
  assert.equal(resolveWorkflowMaxConcurrency(undefined), 4);
  assert.equal(resolveWorkflowMaxConcurrency(0), 4);
  assert.equal(resolveWorkflowMaxConcurrency(21), 4);
  assert.equal(resolveWorkflowMaxConcurrency(3), 3);
});

test("queue creation failures receive a bounded recovery delay", () => {
  assert.equal(
    computeWorkflowQueueRetryAt("2026-08-06T00:00:00.000Z"),
    "2026-08-06T00:01:00.000Z",
  );
});

test("dispatcher rejects an unknown node run without creating a queue task", () => {
  assert.throws(
    () => dispatchReadyWorkflowNodeSync({ workspaceId: "missing-workspace", nodeRunId: "missing-node" }),
    /workflow_node_run_not_found|PostgreSQL database URL is required/,
  );
});
