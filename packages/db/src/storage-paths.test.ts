import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  getDaemonChannelWorkDirPath,
  getDaemonRemoteTaskWorkDirPath,
  getDaemonTaskWorkDirPath,
  getLocalDaemonStateDirPath,
  getSystemWorkspaceDataDirPath,
  getWorkspaceAttachmentsDirPath,
  getWorkspaceChannelHistoryDirPath,
  getWorkspaceDaemonRemoteStagingDirPath,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-storage-paths-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("workspace storage helpers resolve workspace-scoped persistent paths", () => {
  assert.equal(getSystemWorkspaceDataDirPath(), join(tempRoot, "data", "workspaces", "__system__"));

  const attachmentsDir = getWorkspaceAttachmentsDirPath("workspace-mars");
  assert.equal(attachmentsDir, join(tempRoot, "data", "workspaces", "workspace-mars", "attachments"));
  assert.equal(existsSync(attachmentsDir), true);

  const historyDir = getWorkspaceChannelHistoryDirPath("workspace-mars");
  assert.equal(historyDir, join(tempRoot, "data", "workspaces", "workspace-mars", "channel-history"));
  assert.equal(existsSync(historyDir), true);

  assert.equal(
    getWorkspaceDaemonRemoteStagingDirPath("queue 7", "workspace-mars"),
    join(tempRoot, "data", "workspaces", "workspace-mars", "daemon-remote-staging", "queue-7"),
  );
});

test("daemon execution helpers scope workdirs by workspace and execution kind", () => {
  const stateDir = getLocalDaemonStateDirPath();
  assert.equal(stateDir, join(tempRoot, "data", "daemon"));
  assert.equal(existsSync(stateDir), true);

  assert.equal(
    getDaemonTaskWorkDirPath(stateDir, {
      workspaceId: "workspace mars",
      taskId: "queue 7",
    }),
    join(tempRoot, "data", "daemon", "workspaces", "workspace-mars", "workdirs", "queue-7"),
  );

  assert.equal(
    getDaemonChannelWorkDirPath(stateDir, {
      workspaceId: "workspace mars",
      threadId: "direct alpha / 7",
      agentId: "Atlas Planner",
    }),
    join(
      tempRoot,
      "data",
      "daemon",
      "workspaces",
      "workspace-mars",
      "workdirs",
      "channels",
      "direct-alpha-7",
      "Atlas-Planner",
    ),
  );

  assert.equal(
    getDaemonRemoteTaskWorkDirPath(stateDir, {
      workspaceId: "workspace mars",
      taskId: "queue 7",
    }),
    join(tempRoot, "data", "daemon", "workspaces", "workspace-mars", "remote-workdirs", "queue-7"),
  );
});

after(() => {
  process.chdir(originalCwd);
});
