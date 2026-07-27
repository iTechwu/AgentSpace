import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  completeManagedProvisioningStageSync,
  getDatabase,
  insertUnallocatedTokenUsageSync,
  listPendingManagedRuntimeCleanupRequestsForDaemonSync,
  listRuntimeProvisioningTaskEventsSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  markManagedRuntimeCleanupRequestRunningSync,
  registerDaemonRuntimesSync,
  recordTokenUsageSync,
  upsertWorkspaceSsoBindingSync,
  upsertWorkspaceMembershipSync,
} from "@dofe-agent/db";
import {
  cancelRuntimeProvisioningTaskAsync,
  completeManagedRuntimeCleanupSync,
  deleteManagedRuntimeAsync,
  finalizeManagedRuntimeProvisioningSync,
  getManagedRuntimeCredentialStatusAsync,
  getRuntimeProvisioningTaskDetailSync,
  handleManagedRuntimeProviderFailureAsync,
  listManagedRuntimeTasksSync,
  listManagedRuntimesForWorkspaceSync,
  preflightManagedRuntimeCreationAsync,
  requestManagedRuntimeProvisioningSync,
  resumePendingRuntimeCredentialRecoveriesAsync,
  retryRuntimeProvisioningTaskSync,
  rotateManagedRuntimeCredentialAsync,
  runProvisioningPipeline,
  setProvisioningModelsClientProviderForTests,
  stopManagedRuntimeAsync,
  type ModelsClientLike,
} from "./runtime-provisioning.ts";
import { resetRuntimeCredentialVaultForTests, getRuntimeCredentialVault } from "./credential-vault.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-provisioning-svc-"));
const TEAM_WS = "team-workspace";
const TENANT_WS = "tenant-workspace";
const OWNER = "owner-user";
const MEMBER = "member-user";
const PLATFORM_ADMIN = "platform-admin-user";
const originalRuntimeMode = process.env.DOFE_AGENT_RUNTIME_MODE;

function createMockClient(behavior: {
  failCreate?: boolean;
  preflightAllowed?: boolean;
  failRotate?: boolean;
  credentialId?: string;
  nextCredentialId?: string;
  plaintext?: string;
  nextPlaintext?: string;
  modelList?: unknown[];
}): ModelsClientLike & { createCalls: number; preflightCalls: number; revokeCalls: number; rotateCalls: number; getCalls: number; lastRevokeBody?: unknown; lastRotateBody?: unknown } {
  let createCalls = 0;
  let preflightCalls = 0;
  let revokeCalls = 0;
  let rotateCalls = 0;
  let getCalls = 0;
  let lastRevokeBody: unknown;
  let lastRotateBody: unknown;
  return {
    models: {
      async list() {
        return {
          list: behavior.modelList ?? [
            {
              id: "model-test",
              alias: "claude-sonnet",
              model: "claude-sonnet",
              supportedProtocols: ["anthropic", "openai", "gemini"],
              isEnabled: true,
              isDeprecated: false,
            },
          ],
        };
      },
    },
    billing: {
      async preflight() {
        preflightCalls += 1;
        return { allowed: behavior.preflightAllowed ?? true };
      },
    },
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
    get preflightCalls() {
      return preflightCalls;
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
  db.exec("DELETE FROM managed_runtime_cleanup_request");
  db.exec("DELETE FROM runtime_provisioning_task_event");
  db.exec("DELETE FROM runtime_provisioning_task");
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM workspace_sso_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
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
    if (task && (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "retrying")) {
      return task;
    }
    if (task?.stageStatus === "pending" && task.runtimeId && isNodeProvisioningStage(task.stage)) {
      const nextStage = nextNodeProvisioningStage(task.stage);
      completeManagedProvisioningStageSync({
        taskId: task.id,
        workspaceId,
        stage: task.stage,
        nextStage,
      });
      if (task.stage === "health_check") {
        finalizeManagedRuntimeProvisioningSync({
          taskId: task.id,
          workspaceId,
          runtimeId: task.runtimeId,
        });
      }
      continue;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} did not reach a terminal state within ${timeoutMs}ms`);
}

function isNodeProvisioningStage(stage: string): stage is "pull_image" | "install_cli" | "write_credential" | "health_check" {
  return stage === "pull_image" || stage === "install_cli" || stage === "write_credential" || stage === "health_check";
}

function nextNodeProvisioningStage(stage: "pull_image" | "install_cli" | "write_credential" | "health_check") {
  if (stage === "pull_image") return "install_cli";
  if (stage === "install_cli") return "write_credential";
  if (stage === "write_credential") return "health_check";
  return undefined;
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

test("platform administrator can provision without a team membership", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: PLATFORM_ADMIN,
    provider: "claude",
    idempotencyKey: "platform-admin-runtime-key",
  });

  const final = await awaitTaskTerminal(task.id);
  assert.equal(final.status, "succeeded");
  assert.ok(final.runtimeId);
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

test("balance preflight rejects provisioning before a Runtime credential is created", async () => {
  activeClient = createMockClient({ preflightAllowed: false });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "balance-denied-key",
  });
  const failed = await awaitTaskTerminal(task.id);

  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "request_credential");
  assert.match(failed.lastErrorMessage ?? "", /managed_runtime.balance_preflight_rejected/);
  assert.equal(activeClient.preflightCalls, 1);
  assert.equal(activeClient.createCalls, 0);
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

  const publicTask = listManagedRuntimeTasksSync({ workspaceId: TEAM_WS, actorUserId: OWNER })[0]!;
  const publicDetail = getRuntimeProvisioningTaskDetailSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    taskId: task.id,
  });
  assert.equal("secretRef" in publicTask, false);
  assert.equal("configRef" in publicTask, false);
  assert.equal(JSON.stringify(publicDetail).includes("vault://"), false);
  assert.equal(publicDetail.task.credentialConfigured, true);

  bindEmployeeRuntimeSync({ workspaceId: TEAM_WS, employeeName: "atlas", runtimeId: runtime!.id });
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, input_json, queued_at, created_at, updated_at)
     VALUES ('queue-runtime-list', ?, 'atlas', ?, 'completed', '{}'::jsonb, ?, ?, ?)`,
  ).run(TEAM_WS, runtime!.id, now, now, now);
  recordTokenUsageSync({ workspaceId: TEAM_WS, taskQueueId: "queue-runtime-list", agentId: "atlas", modelId: "claude-sonnet", inputTokens: 10, outputTokens: 5, actualCostUsd: 1.25, billingStatus: "reconciled" });
  insertUnallocatedTokenUsageSync({ workspaceId: TEAM_WS, agentId: "atlas", modelId: "claude-sonnet", runtimeCredentialId: runtime!.managedCredentialId!, gatewayRequestId: "gateway-unallocated", actualCostUsd: 0.5, currency: "USD" });

  const managed = listManagedRuntimesForWorkspaceSync({ workspaceId: TEAM_WS, actorUserId: OWNER })[0]!;
  assert.deepEqual(managed.protocols, ["anthropic"]);
  assert.equal(managed.defaultModel, "claude-sonnet");
  assert.equal(managed.assignedEmployeeCount, 1);
  assert.equal(managed.periodActualCostUsd, 1.25);
  assert.equal(managed.unallocatedCostUsd, 0.5);
});

test("model catalog preflight blocks incompatible models before credential creation", async () => {
  activeClient = createMockClient({ modelList: [] });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const preflight = await preflightManagedRuntimeCreationAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "claude-sonnet",
  });
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.code, "managed_runtime.no_compatible_models");

  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "claude-sonnet",
    idempotencyKey: "no-compatible-model-key",
  });
  const failed = await awaitTaskTerminal(task.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.lastErrorMessage ?? "", /managed_runtime.no_compatible_models/);
  assert.equal(activeClient.createCalls, 0);
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
  const failed = await awaitTaskRetryingOrTerminal(task.id);
  assert.equal(failed.status, "retrying");
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

async function awaitTaskRetryingOrTerminal(
  taskId: string,
  workspaceId = TEAM_WS,
  timeoutMs = 2000,
): Promise<NonNullable<ReturnType<typeof readRuntimeProvisioningTaskSync>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readRuntimeProvisioningTaskSync(taskId, workspaceId);
    if (task && (task.status === "retrying" || task.status === "failed" || task.status === "cancelled" || task.status === "succeeded")) {
      return task;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} did not become retrying or terminal within ${timeoutMs}ms`);
}

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

  const cancelled = await cancelRuntimeProvisioningTaskAsync({
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

test("cancel waits for durable node cleanup before deleting an issued runtime", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "cancel-node-cleanup-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeId = provisioned.runtimeId!;
  const daemon = registerDaemonRuntimesSync({
    workspaceId: TEAM_WS,
    daemonKey: "managed-cleanup-node",
    deviceName: "managed-cleanup-node",
    runtimes: [{ provider: "codex", name: "Managed cleanup node control runtime" }],
  }).daemon;
  getDatabase().prepare("UPDATE agent_runtime SET daemon_connection_id = ? WHERE id = ?").run(daemon.id, runtimeId);

  const cancelling = await cancelRuntimeProvisioningTaskAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    taskId: task.id,
    reason: "user_cancelled",
  });
  assert.equal(cancelling.status, "cancelling");
  assert.ok(readAgentRuntimeSync(runtimeId));

  const cleanup = listPendingManagedRuntimeCleanupRequestsForDaemonSync(daemon.id)[0]!;
  assert.equal(cleanup.provisioningTaskId, task.id);
  assert.equal(cleanup.deleteRuntimeOnSuccess, true);
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(cleanup.id)?.status, "running");
  assert.equal(completeManagedRuntimeCleanupSync(cleanup.id, { removed: true })?.status, "succeeded");
  assert.equal(readRuntimeProvisioningTaskSync(task.id, TEAM_WS)?.status, "cancelled");
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

  const rotated = await rotateManagedRuntimeCredentialAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId,
    reason: "manual",
    operationId: "manual-rotation-1",
  });
  assert.equal(rotated.managedCredentialId, "rtc-mock-rotated");
  assert.equal(activeClient.rotateCalls, 1);
  assert.deepEqual((activeClient.lastRotateBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRotateBody as Record<string, string> | undefined)?.teamId, "team-1");
  assert.equal(
    (activeClient.lastRotateBody as Record<string, string> | undefined)?.idempotencyKey,
    "rotate:rtc-mock-1:manual:manual-rotation-1",
  );
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
      rotateManagedRuntimeCredentialAsync({
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
  const status = await getManagedRuntimeCredentialStatusAsync({
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
  const runtimeBeforeStop = readAgentRuntimeSync(runtimeId)!;

  await stopManagedRuntimeAsync({ workspaceId: TEAM_WS, actorUserId: OWNER, runtimeId, reason: "ui_stop" });
  assert.equal(getRuntimeCredentialVault().retrieve(runtimeBeforeStop.credentialSecretRef!), undefined);
  assert.equal(activeClient.revokeCalls, 1);
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.teamId, "team-1");

  // Delete after stop requires a managed runtime; mark it managed again for the test.
  getDatabase().prepare(
    "UPDATE agent_runtime SET provisioning_state = 'managed', managed_credential_id = 'rtc-mock-1', credential_secret_ref = 'vault://runtime-credential/rtc-mock-1' WHERE id = ?",
  ).run(runtimeId);

  await deleteManagedRuntimeAsync({ workspaceId: TEAM_WS, actorUserId: OWNER, runtimeId, reason: "ui_delete" });
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
      rotateManagedRuntimeCredentialAsync({
        workspaceId: TEAM_WS,
        actorUserId: MEMBER,
        runtimeId,
      }),
    /owners and admins/,
  );
  await assert.rejects(
    () => stopManagedRuntimeAsync({ workspaceId: TEAM_WS, actorUserId: MEMBER, runtimeId }),
    /owners and admins/,
  );
  await assert.rejects(
    () => deleteManagedRuntimeAsync({ workspaceId: TEAM_WS, actorUserId: MEMBER, runtimeId }),
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

test("credential-invalid gateway failure rotates once and restores the managed runtime", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "recovery-success-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeBefore = readAgentRuntimeSync(provisioned.runtimeId!)!;
  activeClient = createMockClient({
    credentialId: runtimeBefore.managedCredentialId,
    nextCredentialId: "rtc-recovered",
    nextPlaintext: "sk-runtime-recovered",
  });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const recovered = await handleManagedRuntimeProviderFailureAsync({
    workspaceId: TEAM_WS,
    runtimeId: runtimeBefore.id,
    sourceTaskId: "failed-task-1",
    reportedCredentialId: runtimeBefore.managedCredentialId!,
    errorCode: "provider.auth_invalid",
    now: new Date("2026-07-27T00:00:00.000Z"),
  });

  assert.equal(recovered.status, "recovered");
  assert.equal(activeClient.rotateCalls, 1);
  assert.equal(readAgentRuntimeSync(runtimeBefore.id)?.managedCredentialId, "rtc-recovered");
  assert.equal(readAgentRuntimeSync(runtimeBefore.id)?.provisioningState, "managed");

  const replay = await handleManagedRuntimeProviderFailureAsync({
    workspaceId: TEAM_WS,
    runtimeId: runtimeBefore.id,
    sourceTaskId: "failed-task-1",
    reportedCredentialId: runtimeBefore.managedCredentialId!,
    errorCode: "provider.auth_invalid",
    now: new Date("2026-07-27T00:02:00.000Z"),
  });
  assert.equal(replay.status, "ignored");
  assert.equal(activeClient.rotateCalls, 1);
});

test("model availability failures never rotate a managed runtime credential", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "codex",
    idempotencyKey: "recovery-model-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtime = readAgentRuntimeSync(provisioned.runtimeId!)!;

  const result = await handleManagedRuntimeProviderFailureAsync({
    workspaceId: TEAM_WS,
    runtimeId: runtime.id,
    sourceTaskId: "failed-task-model",
    reportedCredentialId: runtime.managedCredentialId!,
    errorCode: "provider.model_unavailable",
    now: new Date("2026-07-27T00:00:00.000Z"),
  });

  assert.equal(result.status, "ignored");
  assert.equal(activeClient.rotateCalls, 0);
  assert.equal(readAgentRuntimeSync(runtime.id)?.provisioningState, "managed");
});

test("credential recovery observes cooldown and opens the circuit after three failures", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "gemini",
    idempotencyKey: "recovery-failure-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtime = readAgentRuntimeSync(provisioned.runtimeId!)!;
  activeClient = createMockClient({ failRotate: true, credentialId: runtime.managedCredentialId });
  setProvisioningModelsClientProviderForTests(() => activeClient);
  const failure = {
    workspaceId: TEAM_WS,
    runtimeId: runtime.id,
    sourceTaskId: "failed-task-auth",
    reportedCredentialId: runtime.managedCredentialId!,
    errorCode: "provider.auth_invalid" as const,
  };

  assert.equal((await handleManagedRuntimeProviderFailureAsync({
    ...failure,
    now: new Date("2026-07-27T00:00:00.000Z"),
  })).status, "retry_scheduled");
  assert.deepEqual(await resumePendingRuntimeCredentialRecoveriesAsync({
    workspaceId: TEAM_WS,
    now: new Date("2026-07-27T00:00:30.000Z"),
  }), []);
  assert.equal(activeClient.rotateCalls, 1);
  assert.equal((await resumePendingRuntimeCredentialRecoveriesAsync({
    workspaceId: TEAM_WS,
    now: new Date("2026-07-27T00:01:01.000Z"),
  }))[0]?.status, "retry_scheduled");
  assert.equal((await resumePendingRuntimeCredentialRecoveriesAsync({
    workspaceId: TEAM_WS,
    now: new Date("2026-07-27T00:02:02.000Z"),
  }))[0]?.status, "needs_attention");

  assert.equal(activeClient.rotateCalls, 3);
  assert.equal(readAgentRuntimeSync(runtime.id)?.provisioningState, "needs_attention");
  assert.equal(readAgentRuntimeSync(runtime.id)?.status, "offline");

  activeClient = createMockClient({
    credentialId: runtime.managedCredentialId,
    nextCredentialId: "rtc-manually-recovered",
  });
  setProvisioningModelsClientProviderForTests(() => activeClient);
  const manuallyRecovered = await rotateManagedRuntimeCredentialAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId: runtime.id,
    reason: "manual",
  });
  assert.equal(manuallyRecovered.provisioningState, "managed");
  assert.equal(manuallyRecovered.status, "online");
});

test("heartbeat reclaims an expired credential recovery lease after restart", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "recovery-expired-lease-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtime = readAgentRuntimeSync(provisioned.runtimeId!)!;
  activeClient = createMockClient({ failRotate: true, credentialId: runtime.managedCredentialId });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  await handleManagedRuntimeProviderFailureAsync({
    workspaceId: TEAM_WS,
    runtimeId: runtime.id,
    sourceTaskId: "failed-task-expired-lease",
    reportedCredentialId: runtime.managedCredentialId!,
    errorCode: "provider.auth_invalid",
    now: new Date("2026-07-27T00:00:00.000Z"),
  });
  getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = 'running', cooldown_until = NULL, updated_at = '2026-07-27T00:01:00.000Z'
     WHERE runtime_id = ?`,
  ).run(runtime.id);

  const resumed = await resumePendingRuntimeCredentialRecoveriesAsync({
    workspaceId: TEAM_WS,
    now: new Date("2026-07-27T00:10:00.000Z"),
  });

  assert.equal(resumed[0]?.status, "retry_scheduled");
  assert.equal(activeClient.rotateCalls, 2);
});

test("heartbeat opens the circuit when the final recovery lease expires", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "recovery-final-expired-lease-key",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtime = readAgentRuntimeSync(provisioned.runtimeId!)!;
  activeClient = createMockClient({ failRotate: true, credentialId: runtime.managedCredentialId });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  await handleManagedRuntimeProviderFailureAsync({
    workspaceId: TEAM_WS,
    runtimeId: runtime.id,
    sourceTaskId: "failed-task-final-expired-lease",
    reportedCredentialId: runtime.managedCredentialId!,
    errorCode: "provider.auth_invalid",
    now: new Date("2026-07-27T00:00:00.000Z"),
  });
  getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = 'running', attempt_count = max_attempts,
         cooldown_until = NULL, updated_at = '2026-07-27T00:01:00.000Z'
     WHERE runtime_id = ?`,
  ).run(runtime.id);

  const resumed = await resumePendingRuntimeCredentialRecoveriesAsync({
    workspaceId: TEAM_WS,
    now: new Date("2026-07-27T00:10:00.000Z"),
  });

  assert.equal(resumed[0]?.status, "needs_attention");
  assert.equal(activeClient.rotateCalls, 1);
  assert.equal(readAgentRuntimeSync(runtime.id)?.provisioningState, "needs_attention");
  assert.equal(readAgentRuntimeSync(runtime.id)?.status, "offline");
});

function seed(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const user of [OWNER, MEMBER, PLATFORM_ADMIN]) {
    db.prepare(
      `INSERT INTO users (id, display_name, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET is_admin = excluded.is_admin`,
    ).run(user, user, user === PLATFORM_ADMIN ? 1 : 0, now, now);
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
