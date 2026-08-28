import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createDaemonApiTokenSync,
  createManagedDaemonBootstrapTokenSync,
  createWorkspaceSync,
  listDaemonApiTokensSync,
  readWorkspaceSync,
  registerDaemonRuntimesSync,
  revokeDaemonApiTokenSync,
  validateDaemonApiTokenSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-db-daemon-tokens-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  if (!readWorkspaceSync("default")) {
    createWorkspaceSync({
      id: "default",
      slug: "default",
      name: "Default Workspace",
      createdBy: "system",
    });
  }
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM daemon_api_token");
});

test("daemon api tokens can be created, validated, and revoked", () => {
  const created = createDaemonApiTokenSync({
    workspaceId: "default",
    label: "remote-build-box",
    createdBy: "techwu",
  });

  assert.ok(created.token.startsWith("adt_"));
  assert.equal(created.purpose, "general");
  assert.equal(listDaemonApiTokensSync().length, 1);

  const validated = validateDaemonApiTokenSync(created.token);
  assert.equal(validated?.id, created.id);
  assert.equal(validated?.workspaceId, "default");
  assert.ok(validated?.lastUsedAt);

  const revoked = revokeDaemonApiTokenSync(created.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(validateDaemonApiTokenSync(created.token), null);
});

test("managed daemon bootstrap tokens retain their dedicated purpose", () => {
  const created = createManagedDaemonBootstrapTokenSync({
    workspaceId: "default",
    label: "managed-node-bootstrap",
    createdBy: "runtime-orchestrator",
  });

  assert.equal(created.purpose, "managed_node_bootstrap");
  assert.equal(validateDaemonApiTokenSync(created.token)?.purpose, "managed_node_bootstrap");
});

test("a daemon token binds exactly one daemon and rejects cross-workspace daemon key reuse", () => {
  const firstToken = createDaemonApiTokenSync({
    workspaceId: "default",
    label: "codex-container",
    createdBy: "techwu",
  });
  const first = registerDaemonRuntimesSync({
    workspaceId: "default",
    daemonTokenId: firstToken.id,
    daemonKey: "runtime-codex-1",
    deviceName: "Runtime Codex 1",
    runtimes: [{ provider: "codex", name: "Codex" }],
  });

  assert.equal(validateDaemonApiTokenSync(firstToken.token)?.daemonConnectionId, first.daemon.id);

  const secondToken = createDaemonApiTokenSync({
    workspaceId: "default",
    label: "claude-container",
    createdBy: "techwu",
  });
  assert.throws(
    () => registerDaemonRuntimesSync({
      workspaceId: "default",
      daemonTokenId: secondToken.id,
      daemonKey: "runtime-codex-1",
      deviceName: "Runtime Codex 1",
      runtimes: [{ provider: "codex", name: "Codex" }],
    }),
    /daemon\.connection_token_bound/,
  );
  assert.throws(
    () => registerDaemonRuntimesSync({
      workspaceId: "workspace-mars",
      daemonKey: "runtime-codex-1",
      deviceName: "Runtime Codex 1",
      runtimes: [{ provider: "codex", name: "Codex" }],
    }),
    /daemon\.key_workspace_mismatch/,
  );
});

test.after(() => {
  process.chdir(originalCwd);
});
