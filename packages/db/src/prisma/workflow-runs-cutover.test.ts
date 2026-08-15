// Unit tests for the workflow-run pg 原型 cutover runner (Phase 2 19 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listWorkflowRunsSync } from "../workflows/runs.ts";
import {
  isWorkflowRunsAsyncReadEnabled,
} from "./workflow-runs-async.ts";
import {
  listWorkflowRunsCutover,
  type ListWorkflowRunsCutoverMetric,
} from "./workflow-runs-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED;
  delete process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED;
  else process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listWorkflowRunsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkflowRunsAsyncReadEnabled(), false);
  const metrics: ListWorkflowRunsCutoverMetric[] = [];
  const result = await listWorkflowRunsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkflowRunsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listWorkflowRunsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED;

  const metrics: ListWorkflowRunsCutoverMetric[] = [];
  const result = await listWorkflowRunsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listWorkflowRunsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listWorkflowRunsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED = "1";
  process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkflowRunsCutoverMetric[] = [];
  const result = await listWorkflowRunsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});