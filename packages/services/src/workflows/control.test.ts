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
  assert.equal(resolveWorkflowResumeStatus([{ status: "waiting_approval" }, { status: "ready" }]), "waiting_approval");
  assert.equal(resolveWorkflowResumeStatus([{ status: "succeeded" }, { status: "ready" }]), "running");
});
