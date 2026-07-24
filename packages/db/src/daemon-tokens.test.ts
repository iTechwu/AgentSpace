import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createDaemonApiTokenSync,
  listDaemonApiTokensSync,
  registerDaemonRuntimesSync,
  revokeDaemonApiTokenSync,
  validateDaemonApiTokenSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-db-daemon-tokens-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM daemon_api_token");
});

test("daemon api tokens can be created, validated, and revoked", () => {
  const created = createDaemonApiTokenSync({
    workspaceId: "default",
    label: "remote-build-box",
    createdBy: "Tianyu",
  });

  assert.ok(created.token.startsWith("adt_"));
  assert.equal(listDaemonApiTokensSync().length, 1);

  const validated = validateDaemonApiTokenSync(created.token);
  assert.equal(validated?.id, created.id);
  assert.equal(validated?.workspaceId, "default");
  assert.ok(validated?.lastUsedAt);

  const revoked = revokeDaemonApiTokenSync(created.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(validateDaemonApiTokenSync(created.token), null);
});

test("a daemon token binds exactly one daemon and rejects cross-workspace daemon key reuse", () => {
  const firstToken = createDaemonApiTokenSync({
    workspaceId: "default",
    label: "codex-container",
    createdBy: "Tianyu",
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
    createdBy: "Tianyu",
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
