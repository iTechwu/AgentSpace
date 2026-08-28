// Unit tests for the task-execution-events list cutover runner.
//
// Tests do not seed rows because task_execution_event.task_id is FK-constrained
// to queued_task, and the enqueue API requires a runtime binding that may not
// exist in the test environment. Instead the tests cover the cutover wiring
// with empty / no-match queries:
//   - flag OFF: short-circuits to sync list, no metric emitted.
//   - flag ON (shadow off): cutover returns an empty array consistently
//     across both primary and fallback paths.
//   - flag ON + shadow ON: at least one metric emitted.

import assert from "node:assert/strict";
import test from "node:test";
import {
  listTaskExecutionEventsSync,
} from "../task-execution-events.ts";
import {
  isTaskExecutionEventsAsyncReadEnabled,
} from "./task-execution-events-async.ts";
import {
  listTaskExecutionEventsCutover,
  type ListTaskExecutionEventsCutoverMetric,
} from "./task-execution-events-cutover.ts";

const ORIGINAL_ASYNC = process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED;
  delete process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED;
  else process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED;
  else process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listTaskExecutionEventsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isTaskExecutionEventsAsyncReadEnabled(), false);
  const metrics: ListTaskExecutionEventsCutoverMetric[] = [];
  const result = await listTaskExecutionEventsCutover(
    { channelName: "cutover-empty-channel" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listTaskExecutionEventsSync({ channelName: "cutover-empty-channel" }));
  assert.equal(metrics.length, 0);
});

test("listTaskExecutionEventsCutover returns correct rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED = "1";
  delete process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED;

  const metrics: ListTaskExecutionEventsCutoverMetric[] = [];
  const result = await listTaskExecutionEventsCutover(
    { channelName: "cutover-empty-channel" },
    (metric) => metrics.push(metric),
  );
  // No rows match → result is empty regardless of primary vs fallback.
  assert.deepEqual(result, []);
  // One metric: primary-up → primary metric; primary-down → fallback metric.
  // Both must carry mismatch=0.
  assert.equal(metrics.length, 1);
  const m = metrics[0]!;
  assert.equal(m.mismatch, 0);
  assert.ok(m.source === "primary" || m.source === "fallback");
});

test("listTaskExecutionEventsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED = "1";
  process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListTaskExecutionEventsCutoverMetric[] = [];
  const result = await listTaskExecutionEventsCutover(
    { channelName: "cutover-empty-channel" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, []);
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});