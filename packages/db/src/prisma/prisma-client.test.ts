import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "../database.ts";
import { registerDaemonRuntimesSync } from "../daemons.ts";
import {
  bindEmployeeRuntimeSync,
  listEmployeeRuntimeBindingsSync,
  unbindEmployeeRuntimeSync,
} from "../employee-bindings.ts";
import {
  createStoredEmployeeSync,
  deleteStoredEmployeeSync,
} from "../workspace-employees.ts";
import { listEmployeeRuntimeBindingsPrisma } from "./employees-runtime-bindings-prisma.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
} from "./prisma-client.ts";

test("shared Prisma client uses the PostgreSQL driver adapter", async () => {
  const client = getDofePrismaClient();
  const rows = await client.$queryRaw<Array<{
    value: number;
    currentTime: Date;
    epoch: string;
  }>>`SELECT 1 AS value, now() AS "currentTime", extract(epoch from now())::text AS epoch`;

  assert.equal(Number(rows[0]?.value), 1);
  assert.ok(rows[0]?.currentTime instanceof Date);
  assert.ok(Math.abs(rows[0]!.currentTime.getTime() - Number(rows[0]!.epoch) * 1_000) < 1_000);
  await disconnectDofePrismaClient();
});

test("employee runtime binding relation matches the legacy JOIN", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const employeeName = `Prisma Relation ${suffix}`;
  const daemonKey = `prisma-relation-${suffix}`;
  createStoredEmployeeSync({
    id: `employee-${suffix}`,
    name: employeeName,
    role: "Agent",
    origin: "manual",
    summary: "Prisma relation test fixture",
    traits: [],
    fit: "Ready",
    status: "active",
    instructions: "",
    skillIds: [],
    channels: [],
  });
  const runtime = registerDaemonRuntimesSync({
    daemonKey,
    deviceName: `Prisma Relation Device ${suffix}`,
    runtimes: [{
      provider: "codex",
      name: `Prisma Relation Runtime ${suffix}`,
      version: "test",
    }],
  }).runtimes[0]!;
  bindEmployeeRuntimeSync({ employeeName, runtimeId: runtime.id });

  try {
    const expected = listEmployeeRuntimeBindingsSync("default")
      .find((binding) => binding.employeeName === employeeName);
    const actual = (await listEmployeeRuntimeBindingsPrisma("default"))
      .find((binding) => binding.employeeName === employeeName);

    assert.ok(expected);
    assert.deepEqual(actual, expected);
    assert.equal(actual?.provider, "codex");
    assert.equal(actual?.runtimeName, runtime.name);
  } finally {
    await disconnectDofePrismaClient();
    unbindEmployeeRuntimeSync(employeeName);
    deleteStoredEmployeeSync(employeeName);
    getDatabase().prepare("DELETE FROM agent_runtime WHERE id = ?").run(runtime.id);
    getDatabase().prepare("DELETE FROM daemon_connection WHERE daemon_key = ?").run(daemonKey);
  }
});
