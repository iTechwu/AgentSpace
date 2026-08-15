// Unit tests for the workflow-definition pg 原型 cutover runner
// (Phase 2 14 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listWorkflowDefinitionsSync } from "../workflows/definitions.ts";
import {
  isWorkflowDefinitionsAsyncReadEnabled,
} from "./workflow-definitions-async.ts";
import {
  listWorkflowDefinitionsCutover,
  type ListWorkflowDefinitionsCutoverMetric,
} from "./workflow-definitions-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED;
  delete process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED;
  else process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listWorkflowDefinitionsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkflowDefinitionsAsyncReadEnabled(), false);
  const metrics: ListWorkflowDefinitionsCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listWorkflowDefinitionsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listWorkflowDefinitionsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED;

  const metrics: ListWorkflowDefinitionsCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listWorkflowDefinitionsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listWorkflowDefinitionsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED = "1";
  process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkflowDefinitionsCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});