import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowLogRecord, buildWorkflowMetricLabels, WORKFLOW_METRICS } from "./observability.ts";
import { redactWorkflowDiagnostic } from "./security.ts";

test("workflow diagnostic redaction removes secret fields, known values and inline credentials", () => {
  const input = {
    token: "secret-value",
    nested: { key: "secret-value", message: "Bearer abc.def", instruction: "safe text" },
  };
  const result = redactWorkflowDiagnostic(input, ["secret-value"]);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("abc.def"), false);
  assert.equal(serialized.includes("safe text"), true);
  assert.equal(input.token, "secret-value", "redaction must not mutate the input");
});

test("workflow diagnostic redaction bounds recursive and oversized values", () => {
  const recursive: Record<string, unknown> = { long: "x".repeat(20) };
  recursive.self = recursive;
  const result = redactWorkflowDiagnostic(recursive, [], { maxDepth: 2, maxStringLength: 5 });

  assert.deepEqual(result, { long: "xxxxx[truncated]", self: "[circular]" });
});

test("workflow metric labels accept stable identifiers and reject user text", () => {
  assert.deepEqual(buildWorkflowMetricLabels({
    workspaceId: "ws-1",
    workflowId: "wf-1",
    nodeType: "employee_task",
    status: "failed",
  }), {
    workspaceId: "ws-1",
    workflowId: "wf-1",
    nodeType: "employee_task",
    status: "failed",
  });

  assert.deepEqual(buildWorkflowMetricLabels({
    workspaceId: "客户空间 含用户正文",
    workflowId: "wf-1\nsecret",
    nodeType: "employee_task",
    status: "failed",
  }), {
    workspaceId: "unknown",
    workflowId: "unknown",
    nodeType: "employee_task",
    status: "failed",
  });
});

test("workflow logs expose only the stable operational contract", () => {
  const record = buildWorkflowLogRecord({
    eventCode: "workflow.node.failed",
    workspaceId: "ws-1",
    workflowId: "wf-1",
    runId: "run-1",
    status: "failed",
    count: 1,
    durationMs: 250,
  });

  assert.deepEqual(Object.keys(record).sort(), ["count", "durationMs", "eventCode", "runId", "status", "workflowId", "workspaceId"]);
  assert.equal(Object.values(WORKFLOW_METRICS).length, 5);
  assert.deepEqual(Object.values(WORKFLOW_METRICS).map((metric) => metric.name), [
    "workflow_trigger_lag_seconds",
    "workflow_run_duration_seconds",
    "workflow_node_failures_total",
    "workflow_join_wait_seconds",
    "workflow_manual_intervention_total",
  ]);
});

