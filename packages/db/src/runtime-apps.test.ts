import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  claimNextRuntimeAppOperationForRuntimeSync,
  completeRuntimeAppOperationSync,
  createRuntimeAppOperationSync,
  failRuntimeAppOperationSync,
  listRuntimeInstalledAppsSync,
  readRuntimeAppOperationSync,
  registerDaemonRuntimesSync,
  startRuntimeAppOperationSync,
  updateRuntimeAppOperationStageSync,
  upsertRuntimeAppCatalogItemsSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-runtime-apps-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_app_skill_binding");
  db.exec("DELETE FROM runtime_app_operation");
  db.exec("DELETE FROM runtime_installed_app");
  db.exec("DELETE FROM runtime_app_catalog_item");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
});

test("runtime app operation lifecycle updates installed app state", () => {
  const runtimeId = createRuntime();
  upsertRuntimeAppCatalogItemsSync([{
    source: "clihub_harness",
    name: "mermaid",
    displayName: "Mermaid",
    entryPoint: "mmdc",
    installStrategy: "cli_hub",
    registryJson: "{}",
  }]);
  const operation = createRuntimeAppOperationSync({
    runtimeId,
    appSource: "clihub_harness",
    appName: "mermaid",
    operation: "install",
    commandPlanJson: JSON.stringify({ app: { source: "clihub_harness", name: "mermaid", version: "", entryPoint: "mmdc" }, strategy: "cli_hub", commands: [], verifyCommands: [], risk: "low", requiresApproval: true, notes: [] }),
  });
  assert.equal(operation.stage, "queued");

  const claimed = claimNextRuntimeAppOperationForRuntimeSync({ runtimeId });
  assert.equal(claimed?.id, operation.id);
  const started = startRuntimeAppOperationSync(operation.id);
  assert.equal(started.status, "running");
  assert.equal(started.stage, "installing");
  assert.equal(updateRuntimeAppOperationStageSync({ operationId: operation.id, stage: "verifying" }).stage, "verifying");
  assert.throws(
    () => updateRuntimeAppOperationStageSync({ operationId: operation.id, stage: "installing" }),
    /runtime_app\.stage_transition_invalid/,
  );
  completeRuntimeAppOperationSync({
    operationId: operation.id,
    installedApp: {
      displayName: "Mermaid",
      version: "1.2.3",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
    },
  });

  const installedApps = listRuntimeInstalledAppsSync({ runtimeId });
  assert.equal(installedApps.length, 1);
  assert.equal(installedApps[0]?.status, "installed");
  assert.equal(installedApps[0]?.enabled, true);
  assert.equal(installedApps[0]?.entryPoint, "mmdc");
  assert.equal(readRuntimeAppOperationSync(operation.id)?.stage, "completed");
});

test("runtime app operation preserves the stage that failed", () => {
  const runtimeId = createRuntime();
  const operation = createRuntimeAppOperationSync({
    runtimeId,
    appSource: "clihub_public",
    appName: "broken-cli",
    operation: "install",
    commandPlanJson: "{}",
  });
  startRuntimeAppOperationSync(operation.id);
  updateRuntimeAppOperationStageSync({ operationId: operation.id, stage: "verifying" });

  const failed = failRuntimeAppOperationSync({ operationId: operation.id, errorMessage: "verification failed" });

  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "verifying");
  assert.equal(failed.failedStage, "verifying");
});

test.after(() => {
  process.chdir(originalCwd);
});

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}
