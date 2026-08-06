import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelWorkflowRunSync,
  computeWorkflowRetryAvailableAt,
  resolveWorkflowResumeStatus,
} from "./retries.ts";

test("retry backoff is exponential and capped at fifteen minutes", () => {
  const now = "2026-08-07T00:00:00.000Z";
  assert.equal(computeWorkflowRetryAvailableAt(now, 2), "2026-08-07T00:00:05.000Z");
  assert.equal(computeWorkflowRetryAvailableAt(now, 20), "2026-08-07T00:15:00.000Z");
});

test("control rejects an unknown run without mutating queues", () => {
  assert.throws(
    () => cancelWorkflowRunSync({ workspaceId: "missing-workspace", runId: "missing-run", actorUserId: "owner", reason: "test" }),
    /workflow_run_not_found|PostgreSQL database URL is required/,
  );
});

test("resume preserves an outstanding approval wait", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [{ id: "a", type: "employee_task" as const, employeeId: "employee-a", config: {} }],
    edges: [],
  };
  assert.equal(resolveWorkflowResumeStatus([
    { nodeId: "a", nodeType: "approval", status: "waiting_approval", inputJson: "{}" },
  ], graph), "waiting_approval");
  assert.equal(resolveWorkflowResumeStatus([
    { nodeId: "a", nodeType: "employee_task", status: "ready", inputJson: "{}" },
  ], graph), "running");
  assert.equal(resolveWorkflowResumeStatus([
    { nodeId: "a", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
  ], graph), "succeeded");
});
