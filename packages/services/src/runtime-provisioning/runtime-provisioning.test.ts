import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  listRuntimeProvisioningTaskEventsSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  upsertWorkspaceSsoBindingSync,
  upsertWorkspaceMembershipSync,
} from "@dofe-agent/db";
import {
  cancelRuntimeProvisioningTaskSync,
  deleteManagedRuntimeSync,
  getManagedRuntimeCredentialStatusSync,
  requestManagedRuntimeProvisioningSync,
  retryRuntimeProvisioningTaskSync,
  rotateManagedRuntimeCredentialSync,
  runProvisioningPipeline,
  setProvisioningModelsClientProviderForTests,
  stopManagedRuntimeSync,
  type ModelsClientLike,
} from "./runtime-provisioning.ts";
import { resetRuntimeCredentialVaultForTests, getRuntimeCredentialVault } from "./credential-vault.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-provisioning-svc-"));
const TEAM_WS = "team-workspace";
const TENANT_WS = "tenant-workspace";
const OWNER = "owner-user";
const MEMBER = "member-user";
const originalRuntimeMode = process.env.DOFE_AGENT_RUNTIME_MODE;

function createMockClient(behavior: {
  failCreate?: boolean;
  failRotate?: boolean;
  credentialId?: string;
  nextCredentialId?: string;
  plaintext?: string;
  nextPlaintext?: string;
}): ModelsClientLike & { createCalls: number; revokeCalls: number; rotateCalls: number; getCalls: number; lastRevokeBody?: unknown; lastRotateBody?: unknown } {
  let createCalls = 0;
  let revokeCalls = 0;
  let rotateCalls = 0;
  let getCalls = 0;
  let lastRevokeBody: unknown;
  let lastRotateBody: unknown;
  return {
    runtimeCredentials: {
      async create({ body }) {
        createCalls += 1;
        if (behavior.failCreate) {
          throw new Error("models.create_failed");
        }
        return {
          credential: {
            id: behavior.credentialId ?? "rtc-mock-1",
            keyFingerprint: "sha256:mock",
            runtimeId: String(body.runtimeId ?? ""),
          },
          secret: { apiKey: behavior.plaintext ?? "sk-runtime-plaintext" },
          secretIssued: true,
        };
      },
      async get() {
        getCalls += 1;
        return {
          id: behavior.credentialId ?? "rtc-mock-1",
          tenantId: "tenant-1",
          teamId: "team-1",
          runtimeId: "runtime-managed-test",
          runtimeType: "claude",
          protocols: ["anthropic"],
          allowedModels: [],
          status: "active",
          keyFingerprint: "sha256:mock",
          rotationVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      async rotate({ body }) {
        rotateCalls += 1;
        lastRotateBody = body;
        if (behavior.failRotate) {
          throw new Error("models.rotate_failed");
        }
        return {
          credential: {
            id: behavior.nextCredentialId ?? "rtc-mock-2",
            keyFingerprint: "sha256:mock-rotated",
            runtimeId: String(body.runtimeId ?? ""),
          },
          secret: { apiKey: behavior.nextPlaintext ?? "sk-runtime-plaintext-rotated" },
          secretIssued: true,
        };
      },
      async revoke({ body }) {
        revokeCalls += 1;
        lastRevokeBody = body;
        return { ok: true };
      },
      async models() {
        return { list: [], total: 0 };
      },
    },
    get createCalls() {
      return createCalls;
    },
    get revokeCalls() {
      return revokeCalls;
    },
    get rotateCalls() {
      return rotateCalls;
    },
    get getCalls() {
      return getCalls;
    },
    get lastRevokeBody() {
      return lastRevokeBody;
    },
    get lastRotateBody() {
      return lastRotateBody;
    },
  };
}

let activeClient: ReturnType<typeof createMockClient>;

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
  process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_provisioning_task_event");
  db.exec("DELETE FROM runtime_provisioning_task");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM workspace_sso_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM workspace_snapshot");
  db.exec("DELETE FROM workspace_membership");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM users");
  seed();
  activeClient = createMockClient({});
  setProvisioningModelsClientProviderForTests(() => activeClient);
  resetRuntimeCredentialVaultForTests();
});

after(() => {
  process.chdir(originalCwd);
  if (originalRuntimeMode === undefined) {
    delete process.env.DOFE_AGENT_RUNTIME_MODE;
  } else {
    process.env.DOFE_AGENT_RUNTIME_MODE = originalRuntimeMode;
  }
});

async function awaitTaskTerminal(taskId: string, workspaceId = TEAM_WS, timeoutMs = 2000): Promise<NonNullable<ReturnType<typeof readRuntimeProvisioningTaskSync>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readRuntimeProvisioningTaskSync(taskId, workspaceId);
    if (task && (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} did not reach a terminal state within ${timeoutMs}ms`);
}

test("non-admin member cannot request a managed runtime", () => {
  assert.throws(
    () =>
      requestManagedRuntimeProvisioningSync({
        workspaceId: TEAM_WS,
        actorUserId: MEMBER,
        provider: "claude",
        idempotencyKey: "member-key",
      }),
    /owners and admins/,
  );
});

test("local mode rejects managed provisioning before it calls models", () => {
  delete process.env.DOFE_AGENT_RUNTIME_MODE;
  try {
    assert.throws(
      () =>
        requestManagedRuntimeProvisioningSync({
          workspaceId: TEAM_WS,
          actorUserId: OWNER,
          provider: "claude",
          idempotencyKey: "local-mode-key",
        }),
      /managed_runtime\.remote_mode_required/,
    );
    assert.equal(activeClient.createCalls, 0);
  } finally {
    process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
  }
});

test("tenant-only workspace (no teamId) is rejected", () => {
  assert.throws(
    () =>
      requestManagedRuntimeProvisioningSync({
        workspaceId: TENANT_WS,
        actorUserId: OWNER,
        provider: "claude",
        idempotencyKey: "tenant-key",
      }),
    /team_scoped_workspace_required/,
  );
});

test("happy path: pipeline reaches ready and binds a managed credential", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "claude-sonnet",
    idempotencyKey: "happy-key",
  });
  const final = await awaitTaskTerminal(task.id);
  assert.equal(final.status, "succeeded");
  assert.equal(final.stage, "ready");
  assert.equal(final.runtimeCredentialId, "rtc-mock-1");
  assert.ok(final.runtimeId);

  const runtime = readAgentRuntimeSync(final.runtimeId!);
  assert.equal(runtime?.provisioningState, "managed");
  assert.equal(runtime?.managedCredentialId, "rtc-mock-1");
  assert.deepEqual(runtime?.protocols, ["anthropic"]);
  assert.equal(runtime?.defaultModel, "claude-sonnet");
  // The opaque ref is stored, never the plaintext.
  assert.ok(runtime?.credentialSecretRef?.startsWith("vault://runtime-credential/"));
  const allRows = JSON.stringify({
    task: readRuntimeProvisioningTaskSync(task.id, TEAM_WS),
    runtime,
    events: listRuntimeProvisioningTaskEventsSync(task.id),
  });
  assert.ok(!allRows.includes("sk-runtime-plaintext"));
  // The vault DOES hold the plaintext for the Phase 3 node-side mount.
  assert.equal(getRuntimeCredentialVault().retrieve(runtime!.credentialSecretRef!), "sk-runtime-plaintext");
});

test("idempotency: same key returns the same task and creates the credential once", async () => {
  const first = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "codex",
    idempotencyKey: "idem-key",
  });
  await awaitTaskTerminal(first.id);
  const firstCreateCalls = activeClient.createCalls;

  const second = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "codex",
    idempotencyKey: "idem-key",
  });
  assert.equal(second.id, first.id);
  // The credential was issued exactly once across both requests.
  assert.equal(activeClient.createCalls, firstCreateCalls);
});

test("credential stage failure is located and retryable without re-issuing endlessly", async () => {
  activeClient = createMockClient({ failCreate: true });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "fail-key",
  });
  const failed = await awaitTaskTerminal(task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "request_credential");
  assert.match(failed.lastErrorMessage ?? "", /models.create_failed/);
  assert.equal(activeClient.createCalls, 1);

  // Recover and retry: credential is issued this time.
  activeClient = createMockClient({});
  setProvisioningModelsClientProviderForTests(() => activeClient);
  const retried = retryRuntimeProvisioningTaskSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    taskId: task.id,
  });
  assert.equal(retried.retryCount, 1);
  const final = await awaitTaskTerminal(task.id);
  assert.equal(final.status, "succeeded");
});

test("cancel runs compensation: revokes credential with scope and removes the runtime", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "cancel-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  assert.equal(provisioned.status, "succeeded");
  const runtimeId = provisioned.runtimeId!;

  const cancelled = await cancelRuntimeProvisioningTaskSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    taskId: task.id,
    reason: "user_cancelled",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(activeClient.revokeCalls, 1);
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.teamId, "team-1");
  // Runtime row removed by compensation.
  assert.equal(readAgentRuntimeSync(runtimeId), null);
});

test("rotate issues a new credential and forgets the old vault entry", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "rotate-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  assert.equal(provisioned.status, "succeeded");
  const runtimeId = provisioned.runtimeId!;
  const runtimeBefore = readAgentRuntimeSync(runtimeId)!;
  const oldSecretRef = runtimeBefore.credentialSecretRef!;
  assert.equal(getRuntimeCredentialVault().retrieve(oldSecretRef), "sk-runtime-plaintext");

  activeClient = createMockClient({
    credentialId: "rtc-mock-1",
    nextCredentialId: "rtc-mock-rotated",
    nextPlaintext: "sk-runtime-plaintext-rotated",
  });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const rotated = await rotateManagedRuntimeCredentialSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId,
    reason: "manual",
  });
  assert.equal(rotated.managedCredentialId, "rtc-mock-rotated");
  assert.equal(activeClient.rotateCalls, 1);
  assert.deepEqual((activeClient.lastRotateBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRotateBody as Record<string, string> | undefined)?.teamId, "team-1");
  assert.equal(getRuntimeCredentialVault().retrieve(oldSecretRef), undefined);
  assert.equal(getRuntimeCredentialVault().retrieve(rotated.credentialSecretRef!), "sk-runtime-plaintext-rotated");
});

test("rotate without a returned secret fails without updating the runtime", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "rotate-no-secret-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeId = provisioned.runtimeId!;
  activeClient = createMockClient({ failRotate: true });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  await assert.rejects(
    () =>
      rotateManagedRuntimeCredentialSync({
        workspaceId: TEAM_WS,
        actorUserId: OWNER,
        runtimeId,
      }),
    /models.rotate_failed/,
  );
  const runtimeAfter = readAgentRuntimeSync(runtimeId)!;
  assert.equal(runtimeAfter.managedCredentialId, "rtc-mock-1");
});

test("get credential status returns upstream metadata without plaintext", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "status-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const status = await getManagedRuntimeCredentialStatusSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId: provisioned.runtimeId!,
  });
  assert.equal(status?.id, "rtc-mock-1");
  assert.equal(status?.status, "active");
  assert.equal(activeClient.getCalls, 1);
});

test("stop and delete pass tenant/team scope to revoke", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "stop-delete-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeId = provisioned.runtimeId!;

  await stopManagedRuntimeSync({ workspaceId: TEAM_WS, actorUserId: OWNER, runtimeId, reason: "ui_stop" });
  assert.equal(activeClient.revokeCalls, 1);
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.teamId, "team-1");

  // Delete after stop requires a managed runtime; mark it managed again for the test.
  getDatabase().prepare(
    "UPDATE agent_runtime SET provisioning_state = 'managed', managed_credential_id = 'rtc-mock-1', credential_secret_ref = 'vault://runtime-credential/rtc-mock-1' WHERE id = ?",
  ).run(runtimeId);

  await deleteManagedRuntimeSync({ workspaceId: TEAM_WS, actorUserId: OWNER, runtimeId, reason: "ui_delete" });
  assert.equal(activeClient.revokeCalls, 2);
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.teamId, "team-1");
});

test("non-admin cannot rotate, stop or delete a managed runtime", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "member-lifecycle-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeId = provisioned.runtimeId!;

  await assert.rejects(
    () =>
      rotateManagedRuntimeCredentialSync({
        workspaceId: TEAM_WS,
        actorUserId: MEMBER,
        runtimeId,
      }),
    /owners and admins/,
  );
  await assert.rejects(
    () => stopManagedRuntimeSync({ workspaceId: TEAM_WS, actorUserId: MEMBER, runtimeId }),
    /owners and admins/,
  );
  await assert.rejects(
    () => deleteManagedRuntimeSync({ workspaceId: TEAM_WS, actorUserId: MEMBER, runtimeId }),
    /owners and admins/,
  );
});

test("resume re-drives a task left running (simulated restart)", async () => {
  // Create a task but drive the pipeline manually so we can inspect resume.
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "gemini",
    idempotencyKey: "resume-key",
  });
  // Let the initial fire-and-forget finish.
  await awaitTaskTerminal(task.id);
  // Force it back to a running-ish stage and resume.
  getDatabase().prepare(
    "UPDATE runtime_provisioning_task SET status = 'running', stage = 'health_check' WHERE id = ?",
  ).run(task.id);
  await runProvisioningPipeline(task.id, TEAM_WS);
  const final = readRuntimeProvisioningTaskSync(task.id, TEAM_WS);
  assert.equal(final?.status, "succeeded");
});

function seed(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const user of [OWNER, MEMBER]) {
    db.prepare(
      "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(user, user, now, now);
  }
  for (const ws of [TEAM_WS, TENANT_WS]) {
    db.prepare(
      "INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(ws, ws, ws, OWNER, now, now);
  }
  upsertWorkspaceMembershipSync({ workspaceId: TEAM_WS, userId: OWNER, role: "owner" });
  upsertWorkspaceMembershipSync({ workspaceId: TEAM_WS, userId: MEMBER, role: "member" });
  upsertWorkspaceMembershipSync({ workspaceId: TENANT_WS, userId: OWNER, role: "owner" });
  upsertWorkspaceSsoBindingSync({
    workspaceId: TEAM_WS,
    tenantId: "tenant-1",
    tenantName: "Acme",
    teamId: "team-1",
    teamName: "Engineering",
    source: "team",
  });
  upsertWorkspaceSsoBindingSync({
    workspaceId: TENANT_WS,
    tenantId: "tenant-1",
    tenantName: "Acme",
    source: "tenant",
  });
}
