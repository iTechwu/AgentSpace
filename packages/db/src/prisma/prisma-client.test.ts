import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  listAuditLogsSync,
  recordAuditLogSync,
} from "../audit-log.ts";
import { registerDaemonRuntimesSync } from "../daemons.ts";
import {
  bindEmployeeRuntimeSync,
  listEmployeeRuntimeBindingsSync,
} from "../employee-bindings.ts";
import {
  createStoredEmployeeSync,
} from "../workspace-employees.ts";
import {
  createWorkspaceSync,
  hardDeleteWorkspaceSync,
} from "../workspaces.ts";
import { listEmployeeRuntimeBindingsPrisma } from "./employees-runtime-bindings-prisma.ts";
import { listAuditLogsPrismaCutover } from "./audit-log-prisma-cutover.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  registerDofePrismaShutdownHooks,
  type PrismaShutdownSignalSource,
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
  const workspaceId = `workspace-prisma-relation-${suffix}`;
  const employeeName = `Prisma Relation ${suffix}`;
  const daemonKey = `prisma-relation-${suffix}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Prisma Relation Workspace ${suffix}`,
    createdBy: "prisma-relation-test",
  });
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
  }, workspaceId);
  const runtime = registerDaemonRuntimesSync({
    daemonKey,
    deviceName: `Prisma Relation Device ${suffix}`,
    workspaceId,
    runtimes: [{
      provider: "codex",
      name: `Prisma Relation Runtime ${suffix}`,
      version: "test",
    }],
  }).runtimes[0]!;
  bindEmployeeRuntimeSync({ workspaceId, employeeName, runtimeId: runtime.id });

  try {
    const expected = listEmployeeRuntimeBindingsSync(workspaceId)
      .find((binding) => binding.employeeName === employeeName);
    const actual = (await listEmployeeRuntimeBindingsPrisma(workspaceId))
      .find((binding) => binding.employeeName === employeeName);

    assert.ok(expected);
    assert.deepEqual(actual, expected);
    assert.equal(actual?.provider, "codex");
    assert.equal(actual?.runtimeName, runtime.name);
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(workspaceId);
  }
});

test("audit log list cutover matches legacy filters on real rows", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspaceId = `workspace-prisma-audit-${suffix}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Prisma Audit Workspace ${suffix}`,
    createdBy: "prisma-audit-test",
  });
  recordAuditLogSync({
    workspaceId,
    title: "Runtime ready",
    note: "Provision completed",
    code: "runtime.ready",
    data: { runtimeId: `runtime-${suffix}`, actorId: `actor-${suffix}` },
  });
  const previous = process.env.AUDIT_LOG_PRISMA_READ_ENABLED;
  process.env.AUDIT_LOG_PRISMA_READ_ENABLED = "1";
  try {
    const options = {
      code: "runtime.ready",
      runtimeId: `runtime-${suffix}`,
      actorId: `actor-${suffix}`,
      limit: 10,
    };
    assert.deepEqual(
      await listAuditLogsPrismaCutover(workspaceId, options),
      listAuditLogsSync(workspaceId, options),
    );
  } finally {
    if (previous === undefined) delete process.env.AUDIT_LOG_PRISMA_READ_ENABLED;
    else process.env.AUDIT_LOG_PRISMA_READ_ENABLED = previous;
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(workspaceId);
  }
});

test("Prisma shutdown hooks disconnect once and remove every listener", async () => {
  const signalSource = new EventEmitter();
  let disconnectCalls = 0;
  let resolveDisconnect!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnect = resolve;
  });
  const unregister = registerDofePrismaShutdownHooks({
    signalSource: signalSource as unknown as PrismaShutdownSignalSource,
    disconnect: async () => {
      disconnectCalls += 1;
      resolveDisconnect();
    },
  });

  signalSource.emit("SIGTERM");
  signalSource.emit("beforeExit");
  await disconnected;

  assert.equal(disconnectCalls, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("beforeExit"), 0);
  unregister();
});
