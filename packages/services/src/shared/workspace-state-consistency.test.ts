import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { deleteStoredEmployeeSync, readWorkspaceStateRecordSync, writeWorkspaceStateRecordSync } from "@dofe-agent/db";
import {
  bindEmployeeRuntimeSync,
  createEmployeeSync,
  initializeOrganizationSync,
  listEmployeeRuntimeBindingsForWorkspaceSync,
  readWorkspaceStateSnapshotSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";
import { listDaemonSnapshotsSync, registerDaemonRuntimesSync } from "@dofe-agent/db";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-local-state-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("readWorkspaceStateSync recovers missing agents from runtime bindings", () => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });
  createEmployeeSync({
    name: "techwu's assistant",
    role: "Planner",
    origin: "manual",
  });

  const runtime = registerDaemonRuntimesSync({
    daemonKey: "local-dev",
    deviceName: "MacBook Pro",
    runtimes: [{ provider: "codex", name: "Local Agent · Codex" }],
  }).runtimes[0];
  bindEmployeeRuntimeSync("techwu's assistant", runtime.id);

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);
  writeWorkspaceStateRecordSync({
    ...persisted!,
    activeEmployees: [],
  });
  deleteStoredEmployeeSync("techwu's assistant");

  const repairedState = readWorkspaceStateSync();

  assert.equal(repairedState.activeEmployees.length, 1);
  assert.equal(repairedState.activeEmployees[0]?.name, "techwu's assistant");
  assert.equal(repairedState.activeEmployees[0]?.origin, "runtime-recovered");
  assert.equal(listEmployeeRuntimeBindingsForWorkspaceSync().length, 1);
  assert.match(repairedState.ledger[0]?.note ?? "", /recovered from native runtime binding/i);
});

test("readWorkspaceStateSnapshotSync projects recovered agents without mutating persisted state", () => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });
  createEmployeeSync({
    name: "techwu's assistant",
    role: "Planner",
    origin: "manual",
  });

  const runtime = registerDaemonRuntimesSync({
    daemonKey: "local-dev-snapshot",
    deviceName: "MacBook Pro",
    runtimes: [{ provider: "codex", name: "Local Agent · Codex" }],
  }).runtimes[0];
  bindEmployeeRuntimeSync("techwu's assistant", runtime.id);

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);
  writeWorkspaceStateRecordSync({
    ...persisted!,
    activeEmployees: [],
  });
  deleteStoredEmployeeSync("techwu's assistant");

  const projectedState = readWorkspaceStateSnapshotSync();
  const persistedStateBeforeRepair = readWorkspaceStateRecordSync();

  assert.equal(projectedState.activeEmployees.length, 1);
  assert.equal(projectedState.activeEmployees[0]?.name, "techwu's assistant");
  assert.equal(projectedState.activeEmployees[0]?.origin, "runtime-recovered");
  assert.equal(
    projectedState.ledger.some((entry) => /recovered from native runtime binding/i.test(entry.note)),
    false,
  );

  assert.equal(persistedStateBeforeRepair?.activeEmployees.length, 0);

  const persistedState = readWorkspaceStateSync();
  assert.equal(persistedState.activeEmployees.length, 1);
  assert.match(persistedState.ledger[0]?.note ?? "", /recovered from native runtime binding/i);
});

test("resetWorkspaceStateSync clears runtime and binding execution state", () => {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });
  createEmployeeSync({
    name: "Atlas",
    role: "Researcher",
    origin: "manual",
  });

  const runtime = registerDaemonRuntimesSync({
    daemonKey: "local-dev-reset",
    deviceName: "MacBook Pro",
    runtimes: [{ provider: "codex", name: "Local Agent · Codex" }],
  }).runtimes[0];
  bindEmployeeRuntimeSync("Atlas", runtime.id);

  resetWorkspaceStateSync();

  assert.equal(readWorkspaceStateSync().activeEmployees.length, 0);
  assert.equal(listEmployeeRuntimeBindingsForWorkspaceSync().length, 0);
  assert.equal(listDaemonSnapshotsSync().length, 0);
});

test.after(() => {
  process.chdir(originalCwd);
});
