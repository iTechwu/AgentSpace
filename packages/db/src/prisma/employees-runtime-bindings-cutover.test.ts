// Unit tests for the employees-runtime-bindings pg 原型 cutover runner
// (Phase 2 5 域 pilot). @deprecated path, kept for fallback during migration.

import assert from "node:assert/strict";
import test from "node:test";
import { listEmployeeRuntimeBindingsSync } from "../employee-bindings.ts";
import { getDatabase } from "../database.ts";
import { createStoredEmployeeSync } from "../workspace-employees.ts";
import {
  isEmployeesRuntimeBindingsAsyncReadEnabled,
} from "./employees-runtime-bindings-async.ts";
import {
  listEmployeeRuntimeBindingsCutover,
  type ListEmployeesRuntimeBindingsCutoverMetric,
} from "./employees-runtime-bindings-cutover.ts";

const ORIGINAL_ASYNC = process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;
const TEST_SUFFIX = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const WORKSPACE_ID = `runtime-binding-cutover-${TEST_SUFFIX}`;
const RUNTIME_ID = `runtime-binding-cutover-runtime-${TEST_SUFFIX}`;

function resetFlags(): void {
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?)`,
  ).run(WORKSPACE_ID, WORKSPACE_ID, "Runtime binding cutover test", now, now);
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, ?, 'codex', 'Cutover runtime', 'online', ?, ?)`,
  ).run(RUNTIME_ID, WORKSPACE_ID, now, now);
  createStoredEmployeeSync({
    id: "employee-cutover",
    name: "Cutover Employee",
    role: "Agent",
    origin: "manual",
    summary: "Runtime binding cutover test employee",
    traits: [],
    fit: "Ready",
    status: "active",
    instructions: "",
    skillIds: [],
    channels: [],
  }, WORKSPACE_ID);
  db.prepare(
    `INSERT INTO employee_runtime_binding (
       workspace_id, employee_id, employee_name, runtime_id, status, generation,
       desired_provider, created_at, updated_at
     ) VALUES (?, 'employee-cutover', 'Cutover Employee', ?, 'online', 1, 'codex', ?, ?)`,
  ).run(WORKSPACE_ID, RUNTIME_ID, now, now);
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
  const db = getDatabase();
  db.prepare("DELETE FROM employee_runtime_binding WHERE workspace_id = ?").run(WORKSPACE_ID);
  db.prepare("DELETE FROM agent_runtime WHERE workspace_id = ?").run(WORKSPACE_ID);
  db.prepare("DELETE FROM workspace_employee WHERE workspace_id = ?").run(WORKSPACE_ID);
  db.prepare("DELETE FROM workspace WHERE id = ?").run(WORKSPACE_ID);
});

test("listEmployeeRuntimeBindingsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isEmployeesRuntimeBindingsAsyncReadEnabled(), false);
  const metrics: ListEmployeesRuntimeBindingsCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsCutover(
    WORKSPACE_ID,
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listEmployeeRuntimeBindingsSync(WORKSPACE_ID));
  assert.equal(metrics.length, 0);
});

test("listEmployeeRuntimeBindingsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.EMPLOYEES_RUNTIME_BINDINGS_ASYNC_READ_ENABLED = "1";
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_SHADOW_READ_ENABLED;

  const metrics: ListEmployeesRuntimeBindingsCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsCutover(
    WORKSPACE_ID,
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listEmployeeRuntimeBindingsSync(WORKSPACE_ID).map((r) => r.employeeId));
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
    WORKSPACE_ID,
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 0);
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});
