import assert from "node:assert/strict";
import test from "node:test";
import { computeWorkflowOutboxRetryAt, workflowOutboxErrorCode } from "./outbox-dispatcher.ts";

test("outbox retry uses bounded exponential backoff", () => {
  const now = "2026-08-07T00:00:00.000Z";
  assert.equal(computeWorkflowOutboxRetryAt(now, 1), "2026-08-07T00:00:05.000Z");
  assert.equal(computeWorkflowOutboxRetryAt(now, 20), "2026-08-07T00:15:00.000Z");
});

test("outbox persistence records only stable non-sensitive error codes", () => {
  assert.equal(workflowOutboxErrorCode(new Error("workflow_node_run_not_found")), "workflow_node_run_not_found");
  assert.equal(workflowOutboxErrorCode(new Error("provider failed with token=secret")), "workflow_outbox_dispatch_failed");
});
