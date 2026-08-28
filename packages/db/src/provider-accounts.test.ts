import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createProviderAccountSync,
  createDaemonApiTokenSync,
  createRuntimeProvisionRequestSync,
  listRuntimeProvisionRequestsSync,
  registerDaemonRuntimesSync,
  updateRuntimeProvisionRequestSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-provider-accounts-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM runtime_provision_request");
  db.exec("DELETE FROM provider_account");
  ensureWorkspace("default");
  ensureWorkspace("workspace-other");
});

test("a runtime inherits its selected provider account and rejects a cross-workspace account", () => {
  const account = createProviderAccountSync({
    workspaceId: "default",
    provider: "claude",
    name: "Engineering Claude",
    billingAccountId: "cc-engineering",
    secretRef: "vault://teams/engineering/claude",
    createdBy: "provider-account-test-user",
  });
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: "provider-account-daemon",
    deviceName: "Team server",
    workspaceId: "default",
    runtimes: [{ provider: "claude", providerAccountId: account.id, name: "Claude runtime" }],
  });
  assert.equal(snapshot.runtimes[0]?.providerAccountId, account.id);
  assert.throws(() => registerDaemonRuntimesSync({
    daemonKey: "wrong-provider-account-daemon",
    deviceName: "Other server",
    workspaceId: "workspace-other",
    runtimes: [{ provider: "claude", providerAccountId: account.id, name: "Claude runtime" }],
  }), /provider_account.invalid_for_runtime/);
  assert.throws(() => registerDaemonRuntimesSync({
    daemonKey: "missing-provider-account-daemon",
    deviceName: "Team server",
    workspaceId: "default",
    runtimes: [{ provider: "claude", name: "Claude runtime" }],
  }), /provider_account.required_for_runtime/);
});

test("runtime provisioning requests are bound to an active account in their workspace", () => {
  const account = createProviderAccountSync({
    provider: "openclaw",
    name: "Research OpenClaw",
    configRef: "config://research/openclaw",
    createdBy: "provider-account-test-user",
  });
  const request = createRuntimeProvisionRequestSync({
    providerAccountId: account.id,
    provider: "openclaw",
    runtimeName: "research-openclaw-01",
    targetServer: "research-runner-01",
    requestedBy: "provider-account-test-user",
  });
  assert.equal(request.status, "requested");
  const token = createDaemonApiTokenSync({
    label: "research-openclaw",
    createdBy: "provider-account-test-user",
  });
  updateRuntimeProvisionRequestSync({
    id: request.id,
    status: "approved",
    expectedStatus: "requested",
    actorUserId: "provider-account-test-user",
    daemonTokenId: token.id,
  });
  registerDaemonRuntimesSync({
    daemonKey: "research-openclaw-daemon",
    daemonTokenId: token.id,
    deviceName: "Research runner",
    runtimes: [{ provider: "openclaw", providerAccountId: account.id, name: "Research OpenClaw" }],
  });
  assert.equal(listRuntimeProvisionRequestsSync().find((item) => item.id === request.id)?.status, "fulfilled");
});

test.after(() => process.chdir(originalCwd));

function ensureWorkspace(id: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('provider-account-test-user', 'Test user', ?, ?) ON CONFLICT(id) DO NOTHING").run(now, now);
  db.prepare("INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 'provider-account-test-user', ?, ?) ON CONFLICT(id) DO NOTHING").run(id, id, id, now, now);
}
