// Unit tests for the workflow-trigger pg 原型 cutover runner (Phase 2 20 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listWorkflowTriggersForWorkflowSync } from "../workflows/definitions.ts";
import {
  isWorkflowTriggersAsyncReadEnabled,
} from "./workflow-triggers-async.ts";
import {
  listWorkflowTriggersCutover,
  type ListWorkflowTriggersCutoverMetric,
} from "./workflow-triggers-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED;
  delete process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED;
  else process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listWorkflowTriggersCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkflowTriggersAsyncReadEnabled(), false);
  const metrics: ListWorkflowTriggersCutoverMetric[] = [];
  const result = await listWorkflowTriggersCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkflowTriggersForWorkflowSync("wf-nonexistent", "default"));
  assert.equal(metrics.length, 0);
});

test("listWorkflowTriggersCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED;

  const metrics: ListWorkflowTriggersCutoverMetric[] = [];
  const result = await listWorkflowTriggersCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(
    listWorkflowTriggersForWorkflowSync("wf-nonexistent", "default").map((r) => r.id),
  );
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listWorkflowTriggersCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED = "1";
  process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkflowTriggersCutoverMetric[] = [];
  const result = await listWorkflowTriggersCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});
