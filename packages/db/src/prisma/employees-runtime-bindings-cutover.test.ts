// Unit tests for the employees-runtime-bindings pg 原型 cutover runner
// (Phase 2 5 域 pilot). @deprecated path, kept for fallback during migration.

import assert from "node:assert/strict";
import test from "node:test";
import { listEmployeeRuntimeBindingsSync } from "../employee-bindings.ts";
import {
  isEmployeesRuntimeBindingsAsyncReadEnabled,
} from "./employees-runtime-bindings-async.ts";
import {
  listEmployeeRuntimeBindingsCutover,
  type ListEmployeesRuntimeBindingsCutoverMetric,
} from "./employees-runtime-bindings-cutover.ts";

const ORIGINAL_ASYNC = process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listEmployeeRuntimeBindingsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isEmployeesRuntimeBindingsAsyncReadEnabled(), false);
  const metrics: ListEmployeesRuntimeBindingsCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listEmployeeRuntimeBindingsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listEmployeeRuntimeBindingsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED = "1";
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;

  const metrics: ListEmployeesRuntimeBindingsCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listEmployeeRuntimeBindingsSync("default").map((r) => r.employeeId));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.employeeId));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listEmployeeRuntimeBindingsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED = "1";
  process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED = "1";

  const metrics: ListEmployeesRuntimeBindingsCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 0);
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});