import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  archiveWorkspaceSync,
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  getDaemonChannelWorkDirPath,
  getDaemonRemoteTaskWorkDirPath,
  getDaemonTaskWorkDirPath,
  getLocalDaemonStateDirPath,
  getWorkspaceChannelHistoryDirPath,
  getWorkspaceDaemonRemoteStagingDirPath,
  registerDaemonRuntimesSync,
  replaceStoredChannelsSync,
  replaceStoredEmployeesSync,
} from "@dofe-agent/db";
import { resetDatabaseForTests } from "../../../db/src/database.ts";
import { scanStorageArtifactsSync } from "./storage-scan.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-storage-scan-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetDatabaseForTests();
  rmSync(join(tempRoot, "data"), { recursive: true, force: true });
  mkdirSync(join(tempRoot, "data"), { recursive: true });
});

test("scanStorageArtifactsSync reports orphan workspace, channel history, daemon workDir, and remote staging entries", () => {
  createWorkspaceSync({
    id: "workspace-mars",
    slug: "workspace-mars",
    name: "Mars Ops",
    createdBy: "user-1",
  });

  replaceStoredChannelsSync([
    {
      name: "Mission Control",
      humanMembers: 0,
      employeeNames: ["Atlas"],
    },
  ], "workspace-mars");
  replaceStoredEmployeesSync([
    {
      name: "Atlas",
      role: "Operator",
      origin: "manual",
      summary: "",
      traits: [],
      fit: "",
      skillIds: [],
      channels: ["Mission Control"],
      status: "active",
    },
  ], "workspace-mars");

  const runtimeSnapshot = registerDaemonRuntimesSync({
    workspaceId: "workspace-mars",
    daemonKey: "daemon-mars",
    deviceName: "mars-console",
    runtimes: [
      {
        provider: "claude",
        name: "Claude Desktop",
      },
    ],
  });
  bindEmployeeRuntimeSync({
    workspaceId: "workspace-mars",
    employeeName: "Atlas",
    runtimeId: runtimeSnapshot.runtimes[0]!.id,
  });

  const queuedTask = enqueueNativeTaskSync({
    workspaceId: "workspace-mars",
    assignee: "Atlas",
    title: "Valid task",
    channel: "Mission Control",
    priority: "medium",
  });
  assert.ok(queuedTask);

  writeFileSync(
    join(getWorkspaceChannelHistoryDirPath("workspace-mars"), "mission-control.md"),
    "# kept\n",
    "utf8",
  );
  writeFileSync(
    join(getWorkspaceChannelHistoryDirPath("workspace-mars"), "stale-channel.md"),
    "# orphan\n",
    "utf8",
  );

  mkdirSync(getWorkspaceDaemonRemoteStagingDirPath(queuedTask.id, "workspace-mars"), { recursive: true });
  mkdirSync(getWorkspaceDaemonRemoteStagingDirPath("queue-missing", "workspace-mars"), { recursive: true });

  const daemonStateDir = getLocalDaemonStateDirPath();
  mkdirSync(
    getDaemonTaskWorkDirPath(daemonStateDir, { workspaceId: "workspace-mars", taskId: queuedTask.id }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonTaskWorkDirPath(daemonStateDir, { workspaceId: "workspace-mars", taskId: "queue-missing" }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonRemoteTaskWorkDirPath(daemonStateDir, { workspaceId: "workspace-mars", taskId: queuedTask.id }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonRemoteTaskWorkDirPath(daemonStateDir, { workspaceId: "workspace-mars", taskId: "queue-missing" }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonChannelWorkDirPath(daemonStateDir, {
      workspaceId: "workspace-mars",
      threadId: "Mission Control",
      agentId: "Atlas",
    }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonChannelWorkDirPath(daemonStateDir, {
      workspaceId: "workspace-mars",
      threadId: "Mission Control",
      agentId: "Ghost",
    }),
    { recursive: true },
  );
  mkdirSync(
    getDaemonChannelWorkDirPath(daemonStateDir, {
      workspaceId: "workspace-mars",
      threadId: "Stale Channel",
      agentId: "Atlas",
    }),
    { recursive: true },
  );

  mkdirSync(join(tempRoot, "data", "workspaces", "workspace-orphan"), { recursive: true });
  mkdirSync(join(getLocalDaemonStateDirPath(), "workspaces", "workspace-orphan"), { recursive: true });
  mkdirSync(join(tempRoot, "data", "attachments"), { recursive: true });
  mkdirSync(join(tempRoot, "data", "channel-history"), { recursive: true });
  mkdirSync(join(tempRoot, "data", "daemon-remote-staging"), { recursive: true });
  mkdirSync(join(getLocalDaemonStateDirPath(), "workdirs"), { recursive: true });

  const result = scanStorageArtifactsSync();

  assert.equal(result.issueCounts["orphan-workspace"], 1);
  assert.equal(result.issueCounts["orphan-channel-history"], 1);
  assert.equal(result.issueCounts["orphan-remote-staging"], 1);
  assert.equal(result.issueCounts["orphan-daemon-workdir"], 5);
  assert.equal(result.issueCounts["legacy-storage-root"], 4);
  assert.equal(result.scannedCount > 0, true);
  assert.deepEqual(
    result.issues.map((issue) => ({
      kind: issue.kind,
      reason: issue.reason,
      path: issue.path.replace(`${tempRoot}/`, ""),
      workspaceId: issue.workspaceId,
    })),
    [
      {
        kind: "legacy-storage-root",
        reason: "legacy_path",
        path: "data/attachments",
        workspaceId: undefined,
      },
      {
        kind: "legacy-storage-root",
        reason: "legacy_path",
        path: "data/channel-history",
        workspaceId: undefined,
      },
      {
        kind: "legacy-storage-root",
        reason: "legacy_path",
        path: "data/daemon-remote-staging",
        workspaceId: undefined,
      },
      {
        kind: "legacy-storage-root",
        reason: "legacy_path",
        path: "data/daemon/workdirs",
        workspaceId: undefined,
      },
      {
        kind: "orphan-channel-history",
        reason: "channel_missing",
        path: "data/workspaces/workspace-mars/channel-history/stale-channel.md",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-daemon-workdir",
        reason: "task_missing",
        path: "data/daemon/workspaces/workspace-mars/remote-workdirs/queue-missing",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-daemon-workdir",
        reason: "agent_missing",
        path: "data/daemon/workspaces/workspace-mars/workdirs/channels/Mission-Control/Ghost",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-daemon-workdir",
        reason: "channel_missing",
        path: "data/daemon/workspaces/workspace-mars/workdirs/channels/Stale-Channel",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-daemon-workdir",
        reason: "task_missing",
        path: "data/daemon/workspaces/workspace-mars/workdirs/queue-missing",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-daemon-workdir",
        reason: "workspace_missing",
        path: "data/daemon/workspaces/workspace-orphan",
        workspaceId: "workspace-orphan",
      },
      {
        kind: "orphan-remote-staging",
        reason: "task_missing",
        path: "data/workspaces/workspace-mars/daemon-remote-staging/queue-missing",
        workspaceId: "workspace-mars",
      },
      {
        kind: "orphan-workspace",
        reason: "workspace_missing",
        path: "data/workspaces/workspace-orphan",
        workspaceId: "workspace-orphan",
      },
    ],
  );
});

test("scanStorageArtifactsSync keeps archived workspace storage out of orphan-workspace results", () => {
  createWorkspaceSync({
    id: "workspace-archive",
    slug: "workspace-archive",
    name: "Archive",
    createdBy: "user-1",
  });
  archiveWorkspaceSync("workspace-archive");
  mkdirSync(join(tempRoot, "data", "workspaces", "workspace-archive"), { recursive: true });

  const result = scanStorageArtifactsSync();

  assert.equal(
    result.issues.some((issue) => issue.kind === "orphan-workspace" && issue.workspaceId === "workspace-archive"),
    false,
  );
});

test.after(() => {
  resetDatabaseForTests();
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
