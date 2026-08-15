// Unit tests for the employees-runtime-bindings Prisma Client cutover runner
// (Phase 2 5 域 pilot production path).

import assert from "node:assert/strict";
import test from "node:test";
import type { EmployeeRuntimeBindingRecord } from "../types.ts";
import {
  setEmployeesRuntimeBindingsPrismaClientForTests,
  disconnectEmployeesRuntimeBindingsPrismaForTests,
} from "./employees-runtime-bindings-prisma.ts";
import {
  listEmployeeRuntimeBindingsPrismaCutover,
  type ListEmployeesRuntimeBindingsPrismaCutoverMetric,
} from "./employees-runtime-bindings-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED;
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setEmployeesRuntimeBindingsPrismaClientForTests(null);
  await disconnectEmployeesRuntimeBindingsPrismaForTests();
  if (ORIGINAL_ASYNC === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaBinding {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  runtimeId: string;
  provider: string;
  runtimeName: string;
  status: string;
  generation: number;
  desiredProvider: string | null;
  boundAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  employeeRuntimeBinding: {
    findMany: (args: unknown) => Promise<MockPrismaBinding[]>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaBinding[]>): MockPrismaClient {
  return { employeeRuntimeBinding: { findMany: behavior } };
}

function toPrismaRow(record: EmployeeRuntimeBindingRecord): MockPrismaBinding {
  return {
    workspaceId: record.workspaceId,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    runtimeId: record.runtimeId,
    provider: record.provider,
    runtimeName: record.runtimeName,
    status: record.status,
    generation: record.generation,
    desiredProvider: record.desiredProvider ?? null,
    boundAt: new Date(record.boundAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listEmployeeRuntimeBindingsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListEmployeesRuntimeBindingsPrismaCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listEmployeeRuntimeBindingsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED = "1";
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: EmployeeRuntimeBindingRecord = {
    workspaceId: "default",
    employeeId: "emp-prisma-mock",
    employeeName: "MockEmployee",
    runtimeId: "rt-prisma-mock",
    provider: "codex",
    runtimeName: "Mock Runtime",
    status: "online",
    generation: 1,
    boundAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setEmployeesRuntimeBindingsPrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setEmployeesRuntimeBindingsPrismaClientForTests>[0],
  );
  const metrics: ListEmployeesRuntimeBindingsPrismaCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.employeeId, "emp-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listEmployeeRuntimeBindingsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_READ_ENABLED = "1";
  delete process.env.EMPLOYEES_RUNTIME_BINDINGS_PRISMA_SHADOW_READ_ENABLED;

  setEmployeesRuntimeBindingsPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma runtime bindings unreachable");
    }) as unknown as Parameters<typeof setEmployeesRuntimeBindingsPrismaClientForTests>[0],
  );
  const metrics: ListEmployeesRuntimeBindingsPrismaCutoverMetric[] = [];
  const result = await listEmployeeRuntimeBindingsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.ok(metrics[0]!.error?.includes("prisma runtime bindings unreachable"));
});