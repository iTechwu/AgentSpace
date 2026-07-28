import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  createWorkspaceSync,
  getLocalDaemonStateDirPath,
  getWorkspaceChannelHistoryDirPath,
  readWorkspaceSync,
} from "@dofe-agent/db";
import {
  resetWorkspaceStateSync,
} from "@dofe-agent/services";
import { runDatabaseCommand } from "./db.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-db-command-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  rmSync(join(tempRoot, "data", "workspaces"), { recursive: true, force: true });
  rmSync(join(tempRoot, "data", "daemon"), { recursive: true, force: true });
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  resetWorkspaceStateSync();
});

test("db storage-scan reports orphan storage artifacts", () => {
  createWorkspaceSync({
    id: "workspace-mars",
    slug: "workspace-mars",
    name: "Workspace Mars",
    createdBy: "system",
  });
  resetWorkspaceStateSync("workspace-mars");

  mkdirSync(join(tempRoot, "data", "workspaces", "workspace-orphan"), { recursive: true });
  writeFileSync(join(getWorkspaceChannelHistoryDirPath("workspace-mars"), "stale.md"), "# stale\n", "utf8");
  mkdirSync(join(getLocalDaemonStateDirPath(), "workspaces", "workspace-orphan"), { recursive: true });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(typeof value === "string" ? value : String(value));
  };

  try {
    const exitCode = runDatabaseCommand("storage-scan", [], "json");
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(logs.join("\n")) as {
    issueCounts: Record<string, number>;
  };
  assert.equal(result.issueCounts["orphan-workspace"] >= 1, true);
  assert.equal(result.issueCounts["orphan-channel-history"] >= 1, true);
  assert.equal(result.issueCounts["orphan-daemon-workdir"] >= 1, true);
});

test("db workspace-purge removes the target workspace when forced", () => {
  const workspaceId = "workspace-venus";
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: "Workspace Venus",
    createdBy: "system",
  });
  resetWorkspaceStateSync(workspaceId);
  mkdirSync(join(tempRoot, "data", "workspaces", workspaceId, "channel-history"), { recursive: true });
  writeFileSync(join(tempRoot, "data", "workspaces", workspaceId, "channel-history", "general.md"), "hello", "utf8");

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(typeof value === "string" ? value : String(value));
  };

  try {
    const exitCode = runDatabaseCommand("workspace-purge", ["--id", workspaceId, "--force"], "json");
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(logs.join("\n")) as {
    ok: boolean;
    workspaceId: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.workspaceId, workspaceId);
  assert.equal(readWorkspaceSync(workspaceId), null);
  assert.equal(existsSync(join(tempRoot, "data", "workspaces", workspaceId)), false);
});

after(() => {
  process.chdir(originalCwd);
});
