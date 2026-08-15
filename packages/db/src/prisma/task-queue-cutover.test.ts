// Unit tests for the task-queue pg 原型 cutover runner
// (Phase 2 6 域). @deprecated path, kept for fallback during migration.

import assert from "node:assert/strict";
import test from "node:test";
import { listQueuedTasksSync } from "../task-queue.ts";
import {
  isTaskQueueAsyncReadEnabled,
} from "./task-queue-async.ts";
import {
  listQueuedTasksCutover,
  type ListTaskQueueCutoverMetric,
} from "./task-queue-cutover.ts";

const ORIGINAL_ASYNC = process.env.TASK_QUEUE_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.TASK_QUEUE_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.TASK_QUEUE_ASYNC_READ_ENABLED;
  delete process.env.TASK_QUEUE_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.TASK_QUEUE_ASYNC_READ_ENABLED;
  else process.env.TASK_QUEUE_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.TASK_QUEUE_SHADOW_READ_ENABLED;
  else process.env.TASK_QUEUE_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listQueuedTasksCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isTaskQueueAsyncReadEnabled(), false);
  const metrics: ListTaskQueueCutoverMetric[] = [];
  const result = await listQueuedTasksCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listQueuedTasksSync());
  assert.equal(metrics.length, 0);
});

test("listQueuedTasksCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.TASK_QUEUE_ASYNC_READ_ENABLED = "1";
  delete process.env.TASK_QUEUE_SHADOW_READ_ENABLED;

  const metrics: ListTaskQueueCutoverMetric[] = [];
  const result = await listQueuedTasksCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listQueuedTasksSync().map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listQueuedTasksCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.TASK_QUEUE_ASYNC_READ_ENABLED = "1";
  process.env.TASK_QUEUE_SHADOW_READ_ENABLED = "1";

  const metrics: ListTaskQueueCutoverMetric[] = [];
  const result = await listQueuedTasksCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});