import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  claimManagedProvisioningStageSync,
  claimDueTokenUsageRetriesSync,
  completeManagedProvisioningStageSync,
  completeRuntimeMaintenanceRunSync,
  createRuntimeMaintenanceRunSync,
  enqueueTokenUsageRetrySync,
  getDatabase,
  getWorkspaceBillingSummarySync,
  findTokenUsageByGatewayRequestIdSync,
  insertUnallocatedTokenUsageSync,
  insertUnallocatedTokenUsageIfAbsentSync,
  listPendingManagedRuntimeCleanupRequestsForDaemonSync,
  listRuntimeCredentialReconciliationTargetsSync,
  listTokenUsageBillingEventsSync,
  listRuntimeProvisioningTaskEventsSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  markManagedRuntimeCleanupRequestRunningSync,
  registerDaemonRuntimesSync,
  recordTokenUsageSync,
  readOldestPendingTokenUsageTimestampForRuntimeCredentialSync,
  readRuntimeMaintenanceRunSync,
  upsertWorkspaceSsoBindingSync,
  upsertWorkspaceMembershipSync,
} from "@dofe-agent/db";
import { resetDatabaseForTests } from "../../../db/src/database.ts";
import {
  cancelRuntimeProvisioningTaskAsync,
  completeManagedRuntimeCleanupSync,
  deleteManagedRuntimeAsync,
  ensureManagedRuntimeCapacitySync,
  finalizeManagedRuntimeProvisioningSync,
  getManagedRuntimeCredentialStatusAsync,
  getRuntimeProvisioningTaskDetailSync,
  handleManagedRuntimeProviderFailureAsync,
  listManagedRuntimeTasksSync,
  listManagedRuntimesForWorkspaceSync,
  listManagedExecutionNodesSync,
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
import {
  isRuntimeCredentialTerminalForReconciliation,
  reconcileRuntimeCredentialUsageEntrySync,
} from "../models/usage-sync.ts";
import { resetRuntimeCredentialVaultForTests, getRuntimeCredentialVault } from "./credential-vault.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-provisioning-svc-"));
const TEAM_WS = "team-workspace";
const TENANT_WS = "tenant-workspace";
const OWNER = "owner-user";
const MEMBER = "member-user";
const PLATFORM_ADMIN = "platform-admin-user";
const originalRuntimeMode = process.env.DOFE_AGENT_RUNTIME_MODE;
const originalGatewayBaseUrl = process.env.MODELS_GATEWAY_BASE_URL;

function createMockClient(behavior: {
  failCreate?: boolean;
  revokeNotFound?: boolean;
  preflightAllowed?: boolean;
  failRotate?: boolean;
  rotateNotFound?: boolean;
  credentialId?: string;
  nextCredentialId?: string;
  plaintext?: string;
  nextPlaintext?: string;
  modelList?: unknown[];
}): ModelsClientLike & { createCalls: number; preflightCalls: number; revokeCalls: number; rotateCalls: number; getCalls: number; lastPreflightBody?: unknown; lastRevokeBody?: unknown; lastRotateBody?: unknown } {
  let createCalls = 0;
  let preflightCalls = 0;
  let revokeCalls = 0;
  let rotateCalls = 0;
  let getCalls = 0;
  let lastPreflightBody: unknown;
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
              modelType: "llm",
              supportedProtocols: ["anthropic", "openai", "openai_response", "gemini"],
              isEnabled: true,
              isDeprecated: false,
            },
          ],
        };
      },
    },
    billing: {
      async preflightByScope(args) {
        preflightCalls += 1;
        lastPreflightBody = args.body;
        assert.ok(args.body.estimatedCharge > 0);
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
        if (behavior.rotateNotFound) {
          throw { status: 404 };
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
        if (behavior.revokeNotFound) {
          throw { status: 404, message: "Not Found" };
        }
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
    get lastPreflightBody() {
      return lastPreflightBody;
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
  process.env.MODELS_GATEWAY_BASE_URL = "http://model.local.dofe.ai/api";
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM managed_runtime_cleanup_request");
  db.exec("DELETE FROM runtime_maintenance_run");
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
  if (originalGatewayBaseUrl === undefined) delete process.env.MODELS_GATEWAY_BASE_URL;
  else process.env.MODELS_GATEWAY_BASE_URL = originalGatewayBaseUrl;
});

async function awaitTaskTerminal(taskId: string, workspaceId = TEAM_WS, timeoutMs = 2000): Promise<NonNullable<ReturnType<typeof readRuntimeProvisioningTaskSync>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readRuntimeProvisioningTaskSync(taskId, workspaceId);
    if (task && (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "retrying")) {
      return task;
    }
    if (task?.stageStatus === "pending" && task.runtimeId && isNodeProvisioningStage(task.stage)) {
      const managedNode = registerDaemonRuntimesSync({
        workspaceId,
        daemonKey: `provisioning-test-node-${workspaceId}`,
        deviceName: "Provisioning test node",
        metadata: { managedNode: true },
        runtimes: [],
      }).daemon;
      assert.equal(claimManagedProvisioningStageSync({
        workspaceId,
        daemonConnectionId: managedNode.id,
      })?.id, task.id);
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

test("remote provisioning falls back to the default data-plane gateway when the env var is unset", () => {
  const gatewayBaseUrl = process.env.MODELS_GATEWAY_BASE_URL;
  delete process.env.MODELS_GATEWAY_BASE_URL;
  try {
    assert.doesNotThrow(() => requestManagedRuntimeProvisioningSync({
      workspaceId: TEAM_WS,
      actorUserId: OWNER,
      provider: "claude",
      idempotencyKey: "default-gateway-key",
    }));
  } finally {
    if (gatewayBaseUrl === undefined) delete process.env.MODELS_GATEWAY_BASE_URL;
    else process.env.MODELS_GATEWAY_BASE_URL = gatewayBaseUrl;
  }
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
  assert.deepEqual((activeClient.lastPreflightBody as { scope: unknown }).scope, {
    tenantId: "tenant-1",
    ssoTeamId: "team-1",
    teamId: null,
    requestId: task.id,
    source: "admin",
  });
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
  insertUnallocatedTokenUsageSync({ workspaceId: TEAM_WS, agentId: "atlas", modelId: "gateway-canonical-model", runtimeCredentialId: runtime!.managedCredentialId!, gatewayRequestId: "gateway-unallocated", inputTokens: 77, outputTokens: 22, actualCostUsd: 0.5, currency: "USD" });
  const repeatedRemoteUsage = insertUnallocatedTokenUsageIfAbsentSync({ workspaceId: TEAM_WS, agentId: "atlas", modelId: "claude-sonnet", runtimeCredentialId: runtime!.managedCredentialId!, gatewayRequestId: "gateway-unallocated", actualCostUsd: 0.5, currency: "USD" });
  assert.equal(repeatedRemoteUsage.inserted, false);
  const reconciliation = { reconciledCount: 0, unallocatedCount: 0, skippedCount: 0, totalRemoteCount: 1 };
  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, runtime!.managedCredentialId!, {
    requestId: "gateway-unallocated",
    model: "claude-sonnet",
    totalCost: 0.5,
    currency: "USD",
    timestamp: now,
  }, reconciliation);
  assert.equal(reconciliation.skippedCount, 0);
  const unallocatedUsage = findTokenUsageByGatewayRequestIdSync("gateway-unallocated", TEAM_WS);
  assert.equal(unallocatedUsage?.billingStatus, "unallocated");
  const duplicateUsage = recordTokenUsageSync({
    workspaceId: TEAM_WS,
    taskQueueId: "queue-runtime-list",
    agentId: "atlas",
    modelId: "claude-sonnet",
    runtimeCredentialId: runtime!.managedCredentialId!,
    gatewayRequestId: "gateway-unallocated",
    inputTokens: 10,
    outputTokens: 5,
  });
  assert.equal(duplicateUsage.id, unallocatedUsage?.id);
  assert.equal(duplicateUsage.billingStatus, "reconciled");
  assert.equal(duplicateUsage.actualCostUsd, 0.5);
  assert.equal(duplicateUsage.taskQueueId, "queue-runtime-list");
  assert.equal(duplicateUsage.modelId, "claude-sonnet");
  assert.equal(duplicateUsage.inputTokens, 77);
  assert.equal(duplicateUsage.outputTokens, 22);
  assert.throws(() => recordTokenUsageSync({
    workspaceId: TEAM_WS,
    taskQueueId: "queue-runtime-list",
    agentId: "atlas",
    modelId: "claude-sonnet",
    runtimeCredentialId: "different-runtime-credential",
    gatewayRequestId: "gateway-unallocated",
    inputTokens: 10,
    outputTokens: 5,
  }), /runtime_credential_mismatch/);

  recordTokenUsageSync({
    workspaceId: TEAM_WS,
    taskQueueId: "queue-runtime-list",
    agentId: "atlas",
    modelId: "local-model-alias",
    runtimeCredentialId: runtime!.managedCredentialId!,
    gatewayRequestId: "gateway-reconciled",
    inputTokens: 3,
    outputTokens: 1,
  });
  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, runtime!.managedCredentialId!, {
    requestId: "gateway-reconciled",
    model: "gateway-canonical-model",
    inputTokens: 88,
    outputTokens: 33,
    totalCost: 0.25,
    currency: "USD",
    timestamp: now,
  }, reconciliation);
  const reconciledUsage = findTokenUsageByGatewayRequestIdSync("gateway-reconciled", TEAM_WS);
  assert.equal(reconciledUsage?.modelId, "gateway-canonical-model");
  assert.equal(reconciledUsage?.inputTokens, 88);
  assert.equal(reconciledUsage?.outputTokens, 33);
  assert.equal(reconciledUsage?.actualCostUsd, 0.25);

  const managed = listManagedRuntimesForWorkspaceSync({ workspaceId: TEAM_WS, actorUserId: OWNER })[0]!;
  assert.deepEqual(managed.protocols, ["anthropic"]);
  assert.equal(managed.defaultModel, "claude-sonnet");
  assert.equal(managed.assignedEmployeeCount, 1);
  assert.equal(managed.periodActualCostUsd, 2);
  assert.equal(managed.unallocatedCostUsd, 0);
});

test("execution capacity reuses a compatible shared managed runtime", async () => {
  const first = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "claude-sonnet",
    idempotencyKey: "capacity-first",
  });
  assert.equal(first.kind, "provisioning");
  if (first.kind !== "provisioning") return;

  const ready = await awaitTaskTerminal(first.task.id);
  assert.ok(ready.runtimeId);

  const reused = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "claude-sonnet",
    idempotencyKey: "capacity-second",
  });

  assert.deepEqual(reused, {
    kind: "reused",
    runtimeId: ready.runtimeId,
    runtimeName: "Managed claude",
  });
  assert.equal(activeClient.createCalls, 1);
});

test("execution capacity provisions an isolated runtime when reuse is disabled", async () => {
  const first = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "capacity-shared",
  });
  assert.equal(first.kind, "provisioning");
  if (first.kind !== "provisioning") return;
  await awaitTaskTerminal(first.task.id);

  const isolated = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "capacity-isolated",
    forceProvisioning: true,
  });

  assert.equal(isolated.kind, "provisioning");
  if (isolated.kind !== "provisioning") return;
  const ready = await awaitTaskTerminal(isolated.task.id);
  assert.equal(ready.status, "succeeded");
  assert.equal(activeClient.createCalls, 2);
});

test("preflight permits provisioning before a managed node joins", async () => {
  const result = await preflightManagedRuntimeCreationAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
  });

  assert.equal(result.allowed, true);
  assert.equal(activeClient.preflightCalls, 1);
});

test("execution capacity queues provisioning before a managed node joins", () => {
  const result = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "capacity-without-node",
  });
  assert.equal(result.kind, "provisioning");
});

test("preflight reports reusable capacity without reserving new-runtime balance", async () => {
  const first = ensureManagedRuntimeCapacitySync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "capacity-for-preflight",
  });
  assert.equal(first.kind, "provisioning");
  if (first.kind !== "provisioning") return;
  const ready = await awaitTaskTerminal(first.task.id);
  const priorPreflightCalls = activeClient.preflightCalls;

  const result = await preflightManagedRuntimeCreationAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
  });

  assert.deepEqual(result.reusableRuntime, {
    id: ready.runtimeId,
    name: "Managed claude",
  });
  assert.equal(result.allowed, true);
  assert.equal(activeClient.preflightCalls, priorPreflightCalls);
});

test("managed execution nodes exclude provider runtimes", () => {
  registerDaemonRuntimesSync({
    workspaceId: TEAM_WS,
    daemonKey: "provider-daemon",
    deviceName: "172.30.30.11 Codex",
    metadata: { managedNode: false },
    runtimes: [{ provider: "codex", name: "Shared Codex", deviceInfo: "172.30.30.11" }],
  });
  registerDaemonRuntimesSync({
    workspaceId: TEAM_WS,
    daemonKey: "managed-node",
    deviceName: "172.30.30.11",
    metadata: { managedNode: true },
    runtimes: [],
  });

  assert.deepEqual(listManagedExecutionNodesSync({ workspaceId: TEAM_WS, actorUserId: OWNER }), [
    { deviceName: "172.30.30.11", status: "online" },
  ]);
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

test("model catalog preflight rejects protocol-compatible non-LLM models", async () => {
  activeClient = createMockClient({
    modelList: [{
      id: "image-model",
      alias: "image-model",
      model: "image-model",
      modelType: "image",
      supportedProtocols: ["anthropic", "openai"],
      isEnabled: true,
      isDeprecated: false,
    }],
  });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const preflight = await preflightManagedRuntimeCreationAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    defaultModel: "image-model",
  });

  assert.equal(preflight.allowed, false);
  assert.equal(preflight.code, "managed_runtime.no_compatible_models");
});

test("usage reconciliation keeps provisional billing pending until models finalizes it", async () => {
  recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "local-model-alias",
    runtimeCredentialId: "rtc-pending",
    gatewayRequestId: "gateway-pending",
    inputTokens: 3,
    outputTokens: 1,
  });
  const pendingResult = { reconciledCount: 0, unallocatedCount: 0, skippedCount: 0, totalRemoteCount: 1 };

  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-pending", {
    id: "usage-pending",
    requestId: "gateway-pending",
    model: "gateway-canonical-model",
    protocol: "anthropic",
    billingStatus: "pending_reconciliation",
    inputTokens: 8,
    outputTokens: 3,
    cacheTokens: 2,
    totalCost: 0.15,
    currency: "USD",
    timestamp: "2026-07-28T01:00:00.000Z",
    startedAt: "2026-07-28T00:59:58.000Z",
    endedAt: "2026-07-28T01:00:00.000Z",
  } as never, pendingResult);

  const pendingUsage = findTokenUsageByGatewayRequestIdSync("gateway-pending", TEAM_WS);
  assert.equal(pendingUsage?.billingStatus, "pending_reconciliation");
  assert.equal(pendingUsage?.actualCostUsd, 0.15);
  assert.equal(pendingUsage?.gatewayUsageId, "usage-pending");
  assert.equal(pendingUsage?.protocol, "anthropic");
  assert.equal(pendingUsage?.cacheTokens, 2);
  assert.equal(pendingUsage?.requestStartedAt, "2026-07-28T00:59:58.000Z");
  assert.equal(pendingUsage?.requestEndedAt, "2026-07-28T01:00:00.000Z");

  const finalResult = { reconciledCount: 0, unallocatedCount: 0, skippedCount: 0, totalRemoteCount: 1 };
  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-pending", {
    id: "usage-pending",
    requestId: "gateway-finalized-alias",
    model: "gateway-canonical-model",
    protocol: "anthropic",
    billingStatus: "reconciled",
    inputTokens: 10,
    outputTokens: 4,
    totalCost: 0.2,
    currency: "USD",
    timestamp: "2026-07-28T01:00:00.000Z",
  } as never, finalResult);

  const finalizedUsage = findTokenUsageByGatewayRequestIdSync("gateway-pending", TEAM_WS);
  assert.equal(finalizedUsage?.billingStatus, "unallocated");
  assert.equal(finalizedUsage?.actualCostUsd, 0.2);
  assert.equal(finalizedUsage?.inputTokens, 10);
  assert.equal(finalizedUsage?.outputTokens, 4);
  assert.equal(findTokenUsageByGatewayRequestIdSync("gateway-finalized-alias", TEAM_WS), null);

  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-pending", {
    id: "usage-unmatched-pending",
    requestId: "gateway-unmatched-pending",
    model: "gateway-canonical-model",
    protocol: "anthropic",
    billingStatus: "estimated",
    totalCost: 0.05,
    currency: "USD",
    timestamp: "2026-07-28T01:02:00.000Z",
  } as never, finalResult);
  assert.equal(
    findTokenUsageByGatewayRequestIdSync("gateway-unmatched-pending", TEAM_WS)?.billingStatus,
    "pending_reconciliation",
  );

  activeClient = createMockClient({ credentialId: "rtc-pending" });
  setProvisioningModelsClientProviderForTests(() => activeClient);
  const provisioningTask = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "pending-usage-attribution",
  });
  const readyTask = await awaitTaskTerminal(provisioningTask.id);
  const runtime = readAgentRuntimeSync(readyTask.runtimeId!);
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, input_json, queued_at, created_at, updated_at)
     VALUES ('queue-pending-attribution', ?, 'atlas', ?, 'completed', '{}'::jsonb, ?, ?, ?)`,
  ).run(TEAM_WS, runtime!.id, now, now, now);
  const attributedPending = recordTokenUsageSync({
    workspaceId: TEAM_WS,
    taskQueueId: "queue-pending-attribution",
    agentId: "atlas",
    modelId: "gateway-canonical-model",
    runtimeCredentialId: "rtc-pending",
    gatewayRequestId: "gateway-unmatched-pending",
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.equal(attributedPending.taskQueueId, "queue-pending-attribution");
  assert.equal(attributedPending.billingStatus, "pending_reconciliation");

  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-pending", {
    id: "usage-unmatched-pending",
    requestId: "gateway-unmatched-pending",
    model: "gateway-canonical-model",
    billingStatus: "reconciled",
    totalCost: 0.08,
    currency: "USD",
    timestamp: "2026-07-28T03:00:00.000Z",
  } as never, finalResult);
  assert.equal(
    findTokenUsageByGatewayRequestIdSync("gateway-unmatched-pending", TEAM_WS)?.billingStatus,
    "reconciled",
  );
});

test("billing summary keeps currencies separate and retains the oldest pending reconciliation timestamp", () => {
  recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "gpt-5",
    runtimeCredentialId: "rtc-currency",
    gatewayRequestId: "gateway-eur",
    inputTokens: 10,
    outputTokens: 2,
    actualCostUsd: 1.5,
    currency: "EUR",
    billingStatus: "pending_reconciliation",
    sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
  });
  recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "gpt-5",
    runtimeCredentialId: "rtc-currency",
    gatewayRequestId: "gateway-usd",
    inputTokens: 5,
    outputTokens: 1,
    actualCostUsd: 2,
    currency: "USD",
    billingStatus: "pending_reconciliation",
    sourceUpdatedAt: "2026-07-21T00:00:00.000Z",
  });

  const billing = getWorkspaceBillingSummarySync(undefined, TEAM_WS);
  assert.equal(billing.pendingReconciliationCostUsd, 2);
  assert.deepEqual(
    billing.billingByCurrency.map((entry) => [entry.currency, entry.pendingReconciliationCost]),
    [["EUR", 1.5], ["USD", 2]],
  );
  assert.equal(
    readOldestPendingTokenUsageTimestampForRuntimeCredentialSync(TEAM_WS, "rtc-currency"),
    "2026-07-20T00:00:00.000Z",
  );
});

test("usage reconciliation applies extension-only corrections", () => {
  recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "gpt-5",
    runtimeCredentialId: "rtc-extension-correction",
    gatewayRequestId: "gateway-extension-correction",
    protocol: "openai",
    inputTokens: 10,
    outputTokens: 2,
    cacheTokens: 0,
    actualCostUsd: 0.1,
    currency: "USD",
    billingStatus: "pending_reconciliation",
    requestStartedAt: "2026-07-28T00:00:00.000Z",
    requestEndedAt: "2026-07-28T00:00:01.000Z",
    sourceUpdatedAt: "2026-07-28T00:00:02.000Z",
  });
  const result = { reconciledCount: 0, unallocatedCount: 0, skippedCount: 0, totalRemoteCount: 1, pendingCount: 0 };
  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-extension-correction", {
    id: "usage-extension-correction",
    requestId: "gateway-extension-correction",
    model: "gpt-5",
    protocol: "anthropic",
    billingStatus: "pending",
    inputTokens: 10,
    outputTokens: 2,
    cacheTokens: 7,
    totalCost: 0.1,
    currency: "USD",
    timestamp: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-28T00:00:03.000Z",
    endedAt: "2026-07-28T00:00:04.000Z",
    updatedAt: "2026-07-28T00:00:05.000Z",
  } as never, result);

  const usage = findTokenUsageByGatewayRequestIdSync("gateway-extension-correction", TEAM_WS);
  assert.equal(result.skippedCount, 0);
  assert.equal(usage?.protocol, "anthropic");
  assert.equal(usage?.cacheTokens, 7);
  assert.equal(usage?.requestStartedAt, "2026-07-28T00:00:03.000Z");
  assert.equal(usage?.sourceUpdatedAt, "2026-07-28T00:00:05.000Z");
  assert.equal(isRuntimeCredentialTerminalForReconciliation("expired"), true);
  assert.equal(isRuntimeCredentialTerminalForReconciliation("rotating"), false);
});

test("billing events preserve the usage lifecycle as replayable snapshots", () => {
  const usage = recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "gpt-5",
    runtimeCredentialId: "rtc-events",
    gatewayRequestId: "gateway-events",
    inputTokens: 10,
    outputTokens: 2,
  });
  reconcileRuntimeCredentialUsageEntrySync(TEAM_WS, "rtc-events", {
    id: "usage-events",
    requestId: "gateway-events",
    model: "gpt-5",
    billingStatus: "pending_reconciliation",
    totalCost: 0.1,
    currency: "USD",
    timestamp: "2026-07-28T00:00:00.000Z",
  } as never, { reconciledCount: 0, unallocatedCount: 0, skippedCount: 0, totalRemoteCount: 1 });

  const events = listTokenUsageBillingEventsSync({ workspaceId: TEAM_WS, tokenUsageId: usage.id });
  assert.deepEqual(events.map((event) => event.eventType), ["usage_recorded", "billing_state_changed"]);
  assert.equal(events.at(-1)?.snapshot.billingStatus, "pending_reconciliation");
  assert.equal(events.at(-1)?.snapshot.actualCostUsd, 0.1);
});

test("usage retry claim is exclusive until its lease expires", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "codex",
    idempotencyKey: "retry-claim-task",
  });
  const final = await awaitTaskTerminal(task.id);
  const queueId = "queue-retry-claim";
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_task_queue (
       id, workspace_id, agent_id, runtime_id, status, input_json, queued_at, created_at, updated_at
     ) VALUES (?, ?, 'atlas', ?, 'completed', '{}'::jsonb, ?, ?, ?)`,
  ).run(queueId, TEAM_WS, final.runtimeId, now, now, now);
  enqueueTokenUsageRetrySync({
    workspaceId: TEAM_WS,
    taskQueueId: queueId,
    agentId: "atlas",
    modelId: "gpt-5",
    runtimeCredentialId: "rtc-retry",
    gatewayRequestId: "gateway-retry-claim",
    inputTokens: 10,
    outputTokens: 2,
  }, new Error("temporary database failure"));

  assert.equal(claimDueTokenUsageRetriesSync(10).length, 1);
  assert.equal(claimDueTokenUsageRetriesSync(10).length, 0);
});

test("runtime maintenance run creation rejects overlapping active runs", () => {
  const first = createRuntimeMaintenanceRunSync();
  assert.throws(() => createRuntimeMaintenanceRunSync(), /runtime_maintenance\.already_running/);
  completeRuntimeMaintenanceRunSync({ id: first.id, status: "succeeded", stages: {} });
  const next = createRuntimeMaintenanceRunSync();
  completeRuntimeMaintenanceRunSync({ id: next.id, status: "succeeded", stages: {} });
});

test("an expired maintenance owner cannot overwrite its fenced run", () => {
  const run = createRuntimeMaintenanceRunSync();
  getDatabase().prepare(
    `UPDATE runtime_maintenance_run
     SET status = 'partial_failure', lease_expires_at = ?, finished_at = ?
     WHERE id = ?`,
  ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", run.id);

  assert.throws(
    () => completeRuntimeMaintenanceRunSync({ id: run.id, status: "succeeded", stages: {} }),
    /runtime_maintenance\.lease_lost/,
  );
  assert.equal(readRuntimeMaintenanceRunSync(run.id)?.status, "partial_failure");
});

test("schema 39 to 42 replay keeps exactly one historical billing snapshot", () => {
  const usage = recordTokenUsageSync({
    workspaceId: TEAM_WS,
    agentId: "atlas",
    modelId: "gpt-5",
    gatewayRequestId: "gateway-schema-replay",
    inputTokens: 3,
    outputTokens: 1,
  });
  getDatabase().prepare("UPDATE app_metadata SET value = '39' WHERE key = 'schema_version'").run();
  resetDatabaseForTests();
  getDatabase();
  getDatabase().prepare("UPDATE app_metadata SET value = '39' WHERE key = 'schema_version'").run();
  resetDatabaseForTests();
  getDatabase();

  const snapshots = listTokenUsageBillingEventsSync({ workspaceId: TEAM_WS, tokenUsageId: usage.id })
    .filter((event) => event.eventType === "migration_snapshot");
  assert.equal(snapshots.length, 1);
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
  assert.equal(cancelled.status, "cancelling");
  assert.equal(activeClient.revokeCalls, 1);
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.tenantId, "tenant-1");
  assert.deepEqual((activeClient.lastRevokeBody as Record<string, string> | undefined)?.teamId, "team-1");
  const cleanup = listPendingManagedRuntimeCleanupRequestsForDaemonSync(
    readAgentRuntimeSync(runtimeId)!.daemonConnectionId!,
  )[0]!;
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(cleanup.id)?.status, "running");
  assert.equal(completeManagedRuntimeCleanupSync(cleanup.id, { removed: true })?.status, "succeeded");
  assert.equal(readRuntimeProvisioningTaskSync(task.id, TEAM_WS)?.status, "cancelled");
  assert.equal(readAgentRuntimeSync(runtimeId), null);
});

test("cancel treats an already revoked Models credential as successful cleanup", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "cancel-credential-already-revoked",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  assert.equal(provisioned.status, "succeeded");
  const runtimeId = provisioned.runtimeId!;

  activeClient = createMockClient({ revokeNotFound: true });
  setProvisioningModelsClientProviderForTests(() => activeClient);
  const cancelled = await cancelRuntimeProvisioningTaskAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    taskId: task.id,
  });

  assert.equal(cancelled.status, "cancelling");
  assert.equal(activeClient.revokeCalls, 1);
  const cleanup = listPendingManagedRuntimeCleanupRequestsForDaemonSync(
    readAgentRuntimeSync(runtimeId)!.daemonConnectionId!,
  )[0]!;
  assert.equal(markManagedRuntimeCleanupRequestRunningSync(cleanup.id)?.status, "running");
  assert.equal(completeManagedRuntimeCleanupSync(cleanup.id, { removed: true })?.status, "succeeded");
  assert.equal(readRuntimeProvisioningTaskSync(task.id, TEAM_WS)?.cleanupStatus, "succeeded");
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
  assert.deepEqual(
    listRuntimeCredentialReconciliationTargetsSync(TEAM_WS)
      .map((target) => ({ credentialId: target.runtimeCredentialId, state: target.state })),
    [
      { credentialId: "rtc-mock-1", state: "draining" },
      { credentialId: "rtc-mock-rotated", state: "active" },
    ],
  );
  assert.equal(getRuntimeCredentialVault().retrieve(rotated.credentialSecretRef!), "sk-runtime-plaintext-rotated");
});

test("reissues a credential in the current team scope when rotation cannot find the old credential", async () => {
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "codex",
    idempotencyKey: "reissue-moved-team-credential",
  });
  const provisioned = await awaitTaskTerminal(task.id);
  const runtimeId = provisioned.runtimeId!;
  activeClient = createMockClient({
    rotateNotFound: true,
    credentialId: "rtc-current-team",
    plaintext: "sk-current-team",
  });
  setProvisioningModelsClientProviderForTests(() => activeClient);

  const repaired = await rotateManagedRuntimeCredentialAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId,
    operationId: "reissue-current-team-1",
  });

  assert.equal(activeClient.rotateCalls, 1);
  assert.equal(activeClient.createCalls, 1);
  assert.equal(repaired.managedCredentialId, "rtc-current-team");
  assert.equal(getRuntimeCredentialVault().retrieve(repaired.credentialSecretRef!), "sk-current-team");
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

test("stop and delete complete when the Models credential is already absent", async () => {
  const stopTask = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "stop-credential-already-absent",
  });
  const stopped = await awaitTaskTerminal(stopTask.id);
  const stopRuntime = readAgentRuntimeSync(stopped.runtimeId!)!;

  activeClient = createMockClient({ revokeNotFound: true });
  setProvisioningModelsClientProviderForTests(() => activeClient);
  await stopManagedRuntimeAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId: stopRuntime.id,
    reason: "ui_stop",
  });
  assert.equal(readAgentRuntimeSync(stopRuntime.id)?.provisioningState, "legacy");

  const deleteTask = requestManagedRuntimeProvisioningSync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    provider: "claude",
    idempotencyKey: "delete-credential-already-absent",
  });
  const deleted = await awaitTaskTerminal(deleteTask.id);
  const deleteRuntime = readAgentRuntimeSync(deleted.runtimeId!)!;

  await deleteManagedRuntimeAsync({
    workspaceId: TEAM_WS,
    actorUserId: OWNER,
    runtimeId: deleteRuntime.id,
    reason: "ui_delete",
  });
  assert.equal(activeClient.revokeCalls, 2);
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
