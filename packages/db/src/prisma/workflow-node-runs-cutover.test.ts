// Unit tests for the workflow-node-run pg 原型 cutover runner (Phase 2 21 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listWorkflowNodeRunsSync } from "../workflows/runs.ts";
import {
  isWorkflowNodeRunsAsyncReadEnabled,
} from "./workflow-node-runs-async.ts";
import {
  listWorkflowNodeRunsCutover,
  type ListWorkflowNodeRunsCutoverMetric,
} from "./workflow-node-runs-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED;
  delete process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED;
  else process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listWorkflowNodeRunsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkflowNodeRunsAsyncReadEnabled(), false);
  const metrics: ListWorkflowNodeRunsCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsCutover(
    { workspaceId: "default", runId: "wr-nonexistent" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkflowNodeRunsSync("default", "wr-nonexistent"));
  assert.equal(metrics.length, 0);
});

test("listWorkflowNodeRunsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED;

  const metrics: ListWorkflowNodeRunsCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsCutover(
    { workspaceId: "default", runId: "wr-nonexistent" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(
    listWorkflowNodeRunsSync("default", "wr-nonexistent").map((r) => r.id),
  );
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listWorkflowNodeRunsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED = "1";
  process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkflowNodeRunsCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsCutover(
    { workspaceId: "default", runId: "wr-nonexistent" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});
