import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  DEFAULT_DAEMON_HEARTBEAT_STALE_MS,
  heartbeatDaemonSync,
  listDaemonSnapshotsSync,
  markDaemonOfflineSync,
  pruneOfflineDaemonsSync,
  readDaemonSnapshotSync,
  registerDaemonRuntimesSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-db-daemons-"));
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  ensureWorkspaceRow("default", "Default Workspace");
  ensureWorkspaceRow("workspace-mars", "Mars Workspace");
});

test("prunes old offline daemon connections within the target workspace", () => {
  registerDaemon("old-default", "default");
  registerDaemon("recent-default", "default");
  registerDaemon("online-default", "default");
  registerDaemon("old-mars", "workspace-mars");

  markDaemonOfflineSync("old-default");
  markDaemonOfflineSync("recent-default");
  markDaemonOfflineSync("old-mars");

  const db = getDatabase();
  const oldHeartbeat = new Date(Date.now() - eightDaysMs()).toISOString();
  const recentHeartbeat = new Date(Date.now() - sixDaysMs()).toISOString();
  db.prepare("UPDATE daemon_connection SET last_heartbeat_at = ? WHERE daemon_key IN (?, ?)")
    .run(oldHeartbeat, "old-default", "old-mars");
  db.prepare("UPDATE daemon_connection SET last_heartbeat_at = ? WHERE daemon_key = ?")
    .run(recentHeartbeat, "recent-default");

  const removed = pruneOfflineDaemonsSync(sevenDaysMs, { workspaceId: "default" });

  assert.equal(removed, 1);
  assert.deepEqual(listDaemonSnapshotsSync("default").map((snapshot) => snapshot.daemon.daemonKey).sort(), [
    "online-default",
    "recent-default",
  ]);
  assert.deepEqual(listDaemonSnapshotsSync("workspace-mars").map((snapshot) => snapshot.daemon.daemonKey), [
    "old-mars",
  ]);
});

test("marks daemon runtimes offline when their heartbeat exceeds the liveness window", () => {
  registerDaemon("stale-default", "default");
  const db = getDatabase();
  const staleHeartbeat = new Date(Date.now() - DEFAULT_DAEMON_HEARTBEAT_STALE_MS - 1_000).toISOString();
  db.prepare("UPDATE daemon_connection SET last_heartbeat_at = ? WHERE daemon_key = ?")
    .run(staleHeartbeat, "stale-default");
  db.prepare(
    `UPDATE agent_runtime
     SET last_heartbeat_at = ?
     WHERE daemon_connection_id = (SELECT id FROM daemon_connection WHERE daemon_key = ?)`,
  ).run(staleHeartbeat, "stale-default");

  const snapshot = listDaemonSnapshotsSync("default").find((item) => item.daemon.daemonKey === "stale-default");

  assert.equal(snapshot?.daemon.status, "offline");
  assert.equal(snapshot?.runtimes.every((runtime) => runtime.status === "offline"), true);
  assert.equal(snapshot?.runtimes.every((runtime) => runtime.lastError === "Daemon heartbeat timed out."), true);
});

test("heartbeat can refresh daemon metadata without changing runtimes", () => {
  registerDaemon("build-box-readiness", "default");

  const snapshot = heartbeatDaemonSync("build-box-readiness", {
    metadata: {
      mode: "remote",
      googleWorkspaceReadiness: {
        executor: "gws",
        gws: { available: true, version: "gws 0.22.5" },
      },
    },
  });
  const metadata = JSON.parse(snapshot.daemon.metadataJson) as {
    googleWorkspaceReadiness?: {
      executor?: string;
      gws?: { available?: boolean; version?: string };
    };
  };

  assert.equal(metadata.googleWorkspaceReadiness?.executor, "gws");
  assert.equal(metadata.googleWorkspaceReadiness?.gws?.available, true);
  assert.equal(snapshot.runtimes.length, 1);
});

test("heartbeat can refresh runtime provider health metadata", () => {
  registerDaemon("openclaw-box", "default");
  const runtime = readDaemonSnapshotSync("openclaw-box").runtimes[0]!;

  const snapshot = heartbeatDaemonSync("openclaw-box", {
    runtimes: [{
      id: runtime.id,
      provider: runtime.provider,
      metadata: {
        providerHealth: {
          status: "broken",
          reason: "OpenClaw auth profile is missing.",
          error: {
            code: "provider.profile_missing",
            category: "profile",
            message: "OpenClaw auth profile is missing.",
          },
        },
      },
    }],
  });
  const metadata = JSON.parse(snapshot.runtimes[0]!.metadataJson) as {
    providerHealth?: { status?: string; error?: { code?: string } };
  };

  assert.equal(metadata.providerHealth?.status, "broken");
  assert.equal(metadata.providerHealth?.error?.code, "provider.profile_missing");
});

test("heartbeat only marks the runtimes it reports as online", () => {
  registerDaemonRuntimesSync({
    daemonKey: "filtered-runtime-heartbeat",
    deviceName: "Build Box",
    workspaceId: "default",
    runtimes: [
      { provider: "codex", name: "Remote Agent · Codex" },
      { provider: "claude", name: "Remote Agent · Claude Code" },
    ],
  });
  const db = getDatabase();
  const snapshot = readDaemonSnapshotSync("filtered-runtime-heartbeat");
  const claudeRuntime = snapshot.runtimes.find((runtime) => runtime.provider === "claude")!;
  const codexRuntime = snapshot.runtimes.find((runtime) => runtime.provider === "codex")!;
  db.prepare("UPDATE agent_runtime SET status = 'offline' WHERE id = ?").run(claudeRuntime.id);

  const refreshed = heartbeatDaemonSync("filtered-runtime-heartbeat", {
    runtimes: [{ id: codexRuntime.id, provider: "codex" }],
  });

  assert.equal(refreshed.runtimes.find((runtime) => runtime.id === codexRuntime.id)?.status, "online");
  assert.equal(refreshed.runtimes.find((runtime) => runtime.id === claudeRuntime.id)?.status, "offline");
});

test.after(() => {
  process.chdir(originalCwd);
});

function registerDaemon(daemonKey: string, workspaceId: string): void {
  registerDaemonRuntimesSync({
    daemonKey,
    deviceName: "Build Box",
    workspaceId,
    runtimes: [
      {
        provider: "codex",
        name: "Remote Agent · Codex",
        version: "1.0.0",
      },
    ],
  });
}

function ensureWorkspaceRow(workspaceId: string, name: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES ('daemon-test-user', 'Daemon Test User', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspace (
       id,
       slug,
       name,
       created_by,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, 'daemon-test-user', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = EXCLUDED.name,
       updated_at = EXCLUDED.updated_at`,
  ).run(workspaceId, workspaceId, name, now, now);
}

function eightDaysMs(): number {
  return 8 * 24 * 60 * 60 * 1000;
}

function sixDaysMs(): number {
  return 6 * 24 * 60 * 60 * 1000;
}
