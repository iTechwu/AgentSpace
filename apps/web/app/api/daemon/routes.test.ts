import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceSync,
  createDaemonApiTokenSync,
  createManagedDaemonBootstrapTokenSync,
  createUserSync,
  createWorkspaceMembershipSync,
  cancelQueuedTaskSync,
  enqueueNativeTaskSync,
  listRuntimeGrantsSync,
  listDaemonSnapshotsSync,
  listQueuedTasksSync,
  readQueuedTaskSync,
  listRuntimeInstalledAppsSync,
  listTaskExecutionEventsSync,
  listTokenUsageSync,
  readWorkspaceSync,
  registerDaemonRuntimesSync,
  createRuntimeAppOperationSync,
  completeRuntimeAppOperationSync,
  upsertSkillServiceCatalogSync,
  createManagedSkillServiceSync,
  createManagedSkillServiceOperationSync,
  readManagedSkillServiceSync,
  readManagedSkillServiceOperationSync,
  createExternalIntegrationSync,
  listExternalDataOperationRunsSync,
  createExternalMessageMappingSync,
  upsertRuntimeAppCatalogItemsSync,
  listPendingExternalMessageOutboxSync,
  upsertExternalChannelBindingSync,
  upsertExternalResourceBindingSync,
  updateAgentRuntimeManagedFieldsSync,
  advanceRuntimeProvisioningTaskStageSync,
  claimManagedProvisioningStageSync,
  createRuntimeProvisioningTaskSync,
  readRuntimeProvisioningTaskSync,
} from "@dofe-agent/db";
import { getDatabase } from "@dofe-agent/db/database";
import {
  bindEmployeeRuntimeSync,
  addChannelEmployeesSync,
  createEmployeeSync,
  createWorkspaceSkillSync,
  FEISHU_LARK_CLI_RESULT_MANIFEST_KIND,
  FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH,
  initializeOrganizationSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  readWorkspaceAttachmentBytesSync,
  reviewApprovalSync,
  sendChannelHumanMessageSync,
  sendContactMessageSync,
  setEmployeeSkillIdsSync,
  setWorkspaceServiceSecretSync,
  unbindEmployeeRuntimeSync,
  writeWorkspaceStateSync,
  setAttachmentStorageClientForTests,
} from "@dofe-agent/services";
import { createTestTosAttachmentStorage } from "@/test-utils/tos-attachment-storage";
import { POST as registerPOST } from "./register/route";
import { POST as heartbeatPOST } from "./heartbeat/route";
import { GET as installScriptGET } from "./install-script/route";
import { GET as packageGET } from "./package/route";
import { POST as claimPOST } from "./runtimes/[runtimeId]/tasks/claim/route";
import { GET as credentialBundleGET } from "./runtimes/[runtimeId]/credential-bundle/route";
import { persistManagedTaskUsagesBestEffort } from "./_lib/task-usage";
import { POST as completePOST } from "./tasks/[taskId]/complete/route";
import { POST as usagePOST } from "./tasks/[taskId]/usage/route";
import { POST as failPOST } from "./tasks/[taskId]/fail/route";
import { GET as inputBundleGET } from "./tasks/[taskId]/input-bundle/route";
import { POST as outputBundlePOST } from "./tasks/[taskId]/output-bundle/route";
import { POST as runtimeApprovalPOST } from "./tasks/[taskId]/runtime-approvals/route";
import { GET as runtimeApprovalGET } from "./tasks/[taskId]/runtime-approvals/[approvalId]/route";
import { POST as startPOST } from "./tasks/[taskId]/start/route";
import { GET as taskStatusGET } from "./tasks/[taskId]/status/route";
import { POST as appOperationClaimPOST } from "./runtimes/[runtimeId]/apps/operations/claim/route";
import { POST as appOperationStartPOST } from "./runtime-app-operations/[operationId]/start/route";
import { POST as appOperationStagePOST } from "./runtime-app-operations/[operationId]/stage/route";
import { POST as appOperationCompletePOST } from "./runtime-app-operations/[operationId]/complete/route";
import { POST as appOperationFailPOST } from "./runtime-app-operations/[operationId]/fail/route";
import { POST as provisioningStageCompletePOST } from "./provisioning-tasks/[taskId]/stages/[stage]/complete/route";
import { POST as provisioningStageFailPOST } from "./provisioning-tasks/[taskId]/stages/[stage]/fail/route";
import { POST as provisioningClaimPOST } from "./provisioning-tasks/claim/route";
import { POST as skillServiceClaimPOST } from "./runtimes/[runtimeId]/skill-services/operations/claim/route";
import { POST as skillServiceStartPOST } from "./skill-service-operations/[operationId]/start/route";
import { POST as skillServiceRenewLeasePOST } from "./skill-service-operations/[operationId]/renew-lease/route";
import { POST as skillServiceCompletePOST } from "./skill-service-operations/[operationId]/complete/route";
import { POST as skillServiceFailPOST } from "./skill-service-operations/[operationId]/fail/route";
import { GET as skillServiceSecretsGET } from "./skill-service-operations/[operationId]/secrets/route";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-routes-"));
const originalCwd = process.cwd();
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testTos = createTestTosAttachmentStorage();

beforeAll(() => {
  setAttachmentStorageClientForTests(testTos.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

afterAll(() => {
});

beforeEach(() => {
  testTos.clear();
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });

  const db = getDatabase();
  db.exec("DELETE FROM task_message");
  db.exec("DELETE FROM task_execution_event");
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM runtime_app_skill_binding");
  db.exec("DELETE FROM runtime_app_operation");
  db.exec("DELETE FROM runtime_installed_app");
  db.exec("DELETE FROM runtime_app_catalog_item");
  db.exec("DELETE FROM runtime_provisioning_task_event");
  db.exec("DELETE FROM runtime_provisioning_task");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM workspace_runtime_grant");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM daemon_api_token");
  db.exec("DELETE FROM external_message_outbox");
  db.exec("DELETE FROM external_message_mapping");
  db.exec("DELETE FROM external_thread_binding");
  db.exec("DELETE FROM external_data_operation_run");
  db.exec("DELETE FROM external_resource_binding");
  db.exec("DELETE FROM external_channel_binding");
  db.exec("DELETE FROM external_user_binding");
  db.exec("DELETE FROM external_integration_event");
  db.exec("DELETE FROM external_integration");
  vi.unstubAllEnvs();
  vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "local");
});

function daemonHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function claimDaemonTaskForTest(token: string, runtimeId: string) {
  const response = await claimPOST(
    new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
      method: "POST",
      headers: daemonHeaders(token),
    }),
    { params: Promise.resolve({ runtimeId }) },
  );
  const payload = await response.json() as {
    task: null | { id: string; bindingGeneration?: number };
  };
  expect(response.status).toBe(200);
  expect(payload.task).not.toBeNull();
  expect(typeof payload.task?.bindingGeneration).toBe("number");
  return payload.task!;
}

async function startDaemonTaskForTest(token: string, taskId: string): Promise<void> {
  const response = await startPOST(
    new Request(`http://localhost/api/daemon/tasks/${taskId}/start`, {
      method: "POST",
      headers: daemonHeaders(token),
    }),
    { params: Promise.resolve({ taskId }) },
  );
  expect(response.status).toBe(200);
}

describe("daemon API routes", () => {
  it("exposes cancelled task status to the authenticated claiming daemon", async () => {
    const daemonToken = createDaemonApiTokenSync({ label: "status-daemon", createdBy: "techwu" });
    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "status-daemon",
          deviceName: "Status Daemon",
          runtimes: [{ provider: "claude", name: "Status Runtime", version: "test" }],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;
    createEmployeeSync({ name: "Status Agent", role: "Tester" });
    bindEmployeeRuntimeSync("Status Agent", runtimeId);
    const queued = enqueueNativeTaskSync({
      assignee: "Status Agent",
      title: "Cancellation status",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Cancellation status" },
    });
    cancelQueuedTaskSync({ taskId: queued!.id, errorText: "Stopped by user." });

    const response = await taskStatusGET(
      new Request(`http://localhost/api/daemon/tasks/${queued!.id}/status`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: { id: queued!.id, status: "cancelled" },
    });
  });

  it("keeps task completion successful when usage persistence needs reconciliation", () => {
    const errors: unknown[] = [];
    const retries: unknown[] = [];
    const persisted = persistManagedTaskUsagesBestEffort({
      usages: [{
        modelId: "gpt-5",
        runtimeCredentialId: "credential-1",
        gatewayRequestId: "gateway-1",
        inputTokens: 10,
        outputTokens: 2,
      }],
      workspaceId: "workspace-1",
      taskId: "task-1",
      agentId: "agent-1",
      runtimeCredentialId: "credential-1",
      recordUsage: () => {
        throw new Error("database unavailable");
      },
      enqueueRetry: (retry) => retries.push(retry),
      onError: (error) => errors.push(error),
    });

    expect(persisted).toBe(false);
    expect(errors).toHaveLength(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      taskQueueId: "task-1",
      gatewayRequestId: "gateway-1",
    });
  });

  it("rejects task completion when neither usage nor its durable retry can be persisted", () => {
    expect(() => persistManagedTaskUsagesBestEffort({
      usages: [{
        modelId: "gpt-5",
        runtimeCredentialId: "credential-1",
        gatewayRequestId: "gateway-1",
        inputTokens: 10,
        outputTokens: 2,
      }],
      workspaceId: "workspace-1",
      taskId: "task-1",
      agentId: "agent-1",
      runtimeCredentialId: "credential-1",
      recordUsage: () => {
        throw new Error("usage unavailable");
      },
      enqueueRetry: () => {
        throw new Error("retry unavailable");
      },
    })).toThrow(/token_usage\.durability_unavailable/);
  });

  it("serves a hosted install script with baked server defaults", async () => {
    const response = await installScriptGET(
      new Request("http://localhost/api/daemon/install-script"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-shellscript");
    expect(body).toContain("DEFAULT_SERVER_URL='http://localhost'");
    expect(body).toContain("DEFAULT_PACKAGE_URL='http://localhost/api/daemon/package'");
  });

  it("rejects package downloads without a daemon bearer token", async () => {
    const response = await packageGET(
      new Request("http://localhost/api/daemon/package"),
    );
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toMatch(/missing daemon bearer token/i);
  });

  it("serves the standalone daemon tarball to authenticated daemon tokens", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });
    const packagePath = join(tempRoot, "dofe-agent-daemon-test.tgz");
    writeFileSync(packagePath, Buffer.alloc(2048, 1));
    process.env.DOFE_AGENT_DAEMON_PACKAGE_PATH = packagePath;

    try {
      const response = await packageGET(
        new Request("http://localhost/api/daemon/package", {
          headers: {
            authorization: `Bearer ${daemonToken.token}`,
          },
        }),
      );
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("dofe-agent-daemon-test.tgz");
      expect(body.length).toBeGreaterThan(1024);
    } finally {
      delete process.env.DOFE_AGENT_DAEMON_PACKAGE_PATH;
      rmSync(packagePath, { force: true });
    }
  });

  it("rejects register requests without a daemon bearer token", async () => {
    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          daemonKey: "no-auth",
          deviceName: "No Auth",
          runtimes: [{ provider: "codex", name: "Remote Codex" }],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toMatch(/missing daemon bearer token/i);
  });

  it("rejects register requests with an invalid daemon token", async () => {
    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders("adt_invalid"),
        body: JSON.stringify({
          daemonKey: "bad-auth",
          deviceName: "Bad Auth",
          runtimes: [{ provider: "codex", name: "Remote Codex" }],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toMatch(/invalid daemon token/i);
  });

  it("rejects register requests with unsupported provider ids", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "bad-provider",
          deviceName: "Bad Provider",
          runtimes: [{ provider: "future-bot", name: "Future Bot" }],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/unsupported provider/i);
  });

  it("registers and heartbeats a remote daemon with daemon token auth", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-1",
          deviceName: "Build Box 1",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();

    expect(registerResponse.status).toBe(200);
    expect(registerPayload.daemon.daemonKey).toBe("build-box-1");
    expect(registerPayload.runtimes).toHaveLength(1);

    const heartbeatResponse = await heartbeatPOST(
      new Request("http://localhost/api/daemon/heartbeat", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-1",
          metadata: {
            mode: "remote",
            runtimeReadiness: {
              executor: "agent-router",
              available: true,
            },
          },
          runtimes: [{
            id: registerPayload.runtimes[0].id,
            provider: "codex",
            metadata: {
              providerHealth: {
                status: "healthy",
                reason: "Provider preflight passed.",
              },
            },
          }],
        }),
      }),
    );
    const heartbeatPayload = await heartbeatResponse.json();

    expect(heartbeatResponse.status).toBe(200);
    expect(heartbeatPayload.daemon.status).toBe("online");
    expect(heartbeatPayload.daemon.lastHeartbeatAt).toBeTruthy();
    expect(JSON.parse(listDaemonSnapshotsSync()[0]!.daemon.metadataJson).runtimeReadiness.available).toBe(true);
    expect(heartbeatPayload.runtimes[0].metadata.providerHealth.status).toBe("healthy");

    const repeatedHeartbeatResponse = await heartbeatPOST(
      new Request("http://localhost/api/daemon/heartbeat", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-1",
        }),
      }),
    );
    const repeatedHeartbeatPayload = await repeatedHeartbeatResponse.json();

    expect(repeatedHeartbeatResponse.status).toBe(200);
    expect(repeatedHeartbeatPayload.daemon.status).toBe("online");
  });

  it("advances and fails managed provisioning stages in the daemon token workspace", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const workspaceId = "workspace-managed-stage-routes";
    if (!readWorkspaceSync(workspaceId)) {
      createWorkspaceSync({
        id: workspaceId,
        slug: workspaceId,
        name: "Managed Stage Routes",
        createdBy: "techwu",
      });
    }
    const requester = createUserSync({ displayName: "Managed Stage Requester" });
    createWorkspaceMembershipSync({
      workspaceId,
      userId: requester.id,
      role: "member",
    });

    const daemonToken = createManagedDaemonBootstrapTokenSync({
      workspaceId,
      label: "managed-stage-node",
      createdBy: requester.id,
    });
    const registration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "managed-stage-node",
          deviceName: "Managed Stage Node",
          metadata: { managedNode: true },
          runtimes: [],
        }),
      }),
    );
    expect(registration.status).toBe(200);

    const completedTask = createRuntimeProvisioningTaskSync({
      workspaceId,
      requestedByUserId: requester.id,
      idempotencyKey: "managed-stage-complete",
      runtimeType: "claude",
      protocols: ["anthropic"],
    });
    advanceRuntimeProvisioningTaskStageSync({
      id: completedTask.id,
      workspaceId,
      stage: "pull_image",
      status: "pending",
      progressPercent: 50,
    });
    const managedNode = listDaemonSnapshotsSync(workspaceId)[0]!.daemon;
    expect(claimManagedProvisioningStageSync({
      workspaceId,
      daemonConnectionId: managedNode.id,
    })?.id).toBe(completedTask.id);

    const completeResponse = await provisioningStageCompletePOST(
      new Request(`http://localhost/api/daemon/provisioning-tasks/${completedTask.id}/stages/pull_image/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: completedTask.id, stage: "pull_image" }) },
    );
    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({
      task: { stage: "install_cli", stageStatus: "pending", workspaceId },
    });
    expect(readRuntimeProvisioningTaskSync(completedTask.id, workspaceId)).toMatchObject({
      stage: "install_cli",
      stageStatus: "pending",
    });

    const prematureCompleteResponse = await provisioningStageCompletePOST(
      new Request(`http://localhost/api/daemon/provisioning-tasks/${completedTask.id}/stages/install_cli/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: completedTask.id, stage: "install_cli" }) },
    );
    expect(prematureCompleteResponse.status).toBe(409);

    const prematureFailResponse = await provisioningStageFailPOST(
      new Request(`http://localhost/api/daemon/provisioning-tasks/${completedTask.id}/stages/install_cli/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({ errorMessage: "should not be accepted before claim" }),
      }),
      { params: Promise.resolve({ taskId: completedTask.id, stage: "install_cli" }) },
    );
    expect(prematureFailResponse.status).toBe(409);
    expect(readRuntimeProvisioningTaskSync(completedTask.id, workspaceId)).toMatchObject({
      stage: "install_cli",
      stageStatus: "pending",
      status: "running",
    });

    advanceRuntimeProvisioningTaskStageSync({
      id: completedTask.id,
      workspaceId,
      stage: "ready",
      status: "pending",
      progressPercent: 95,
    });
    const failedTask = createRuntimeProvisioningTaskSync({
      workspaceId,
      requestedByUserId: requester.id,
      idempotencyKey: "managed-stage-fail",
      runtimeType: "claude",
      protocols: ["anthropic"],
    });
    advanceRuntimeProvisioningTaskStageSync({
      id: failedTask.id,
      workspaceId,
      stage: "pull_image",
      status: "pending",
      progressPercent: 50,
    });
    expect(claimManagedProvisioningStageSync({
      workspaceId,
      daemonConnectionId: managedNode.id,
    })?.id).toBe(failedTask.id);

    const failResponse = await provisioningStageFailPOST(
      new Request(`http://localhost/api/daemon/provisioning-tasks/${failedTask.id}/stages/pull_image/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({ errorCode: "image.pull_failed", errorMessage: "image unavailable" }),
      }),
      { params: Promise.resolve({ taskId: failedTask.id, stage: "pull_image" }) },
    );
    expect(failResponse.status).toBe(200);
    await expect(failResponse.json()).resolves.toMatchObject({
      task: { status: "retrying", lastErrorCode: "image.pull_failed", workspaceId },
    });
    expect(readRuntimeProvisioningTaskSync(failedTask.id, workspaceId)).toMatchObject({
      status: "retrying",
      lastErrorCode: "image.pull_failed",
    });
  });

  it("does not let local daemons claim managed provisioning work", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "local");
    const daemonToken = createDaemonApiTokenSync({
      label: "local-daemon",
      createdBy: "techwu",
    });

    const response = await provisioningClaimPOST(
      new Request("http://localhost/api/daemon/provisioning-tasks/claim", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Managed runtime operations are unavailable in local mode.",
    });
  });

  it("does not let local daemons register ordinary remote runtimes", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-ordinary-daemon",
      createdBy: "techwu",
    });

    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "remote-ordinary-daemon",
          deviceName: "Ordinary provider daemon",
          runtimes: [{ provider: "codex", name: "Local Codex" }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Remote mode only accepts managed runtime nodes.",
    });
  });

  it("rejects generic daemon tokens that claim to be managed nodes in remote mode", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const daemonToken = createDaemonApiTokenSync({
      label: "legacy-generic-token",
      createdBy: "techwu",
    });

    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "spoofed-managed-node",
          deviceName: "Spoofed managed node",
          metadata: { managedNode: true },
          runtimes: [],
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Managed node registration requires a managed bootstrap token.",
    });
  });

  it("blocks a legacy local runtime from claiming tasks after switching to remote mode", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "legacy-local-runtime",
      createdBy: "techwu",
    });
    const registration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "legacy-local-runtime",
          deviceName: "Legacy local runtime",
          runtimes: [{ provider: "codex", name: "Legacy Codex" }],
        }),
      }),
    );
    expect(registration.status).toBe(200);
    const runtimeId = (await registration.json()).runtimes[0].id as string;

    createEmployeeSync({ name: "Legacy Atlas", role: "Planner" });
    bindEmployeeRuntimeSync("Legacy Atlas", runtimeId);
    expect(enqueueNativeTaskSync({
      assignee: "Legacy Atlas",
      title: "Must not run in remote mode",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Must not run in remote mode" },
    })).toBeTruthy();

    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const response = await claimPOST(
      new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Remote mode requires a managed, online runtime.",
    });
  });

  it("allows an offline managed runtime to retrieve its credential bundle while provisioning", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const daemonToken = createManagedDaemonBootstrapTokenSync({
      label: "provisioning-managed-node",
      createdBy: "techwu",
    });
    const registration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "provisioning-managed-node",
          deviceName: "Provisioning managed node",
          metadata: { managedNode: true },
          runtimes: [],
        }),
      }),
    );
    expect(registration.status).toBe(200);

    const runtime = registerDaemonRuntimesSync({
      daemonKey: "provisioning-managed-node",
      deviceName: "Provisioning managed node",
      daemonTokenId: daemonToken.id,
      metadata: { managedNode: true },
      runtimes: [{ provider: "codex", name: "Provisioning Codex" }],
    }).runtimes[0]!;
    updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      managedCredentialId: "provisioning-credential",
      provisioningState: "managed",
      status: "offline",
    });

    const response = await credentialBundleGET(
      new Request(`http://localhost/api/daemon/runtimes/${runtime.id}/credential-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId: runtime.id }) },
    );

    // The request reached credential validation; an online check would return 409 instead.
    expect(response.status).toBe(404);
  });

  it("blocks a legacy generic token from executing through an existing managed runtime", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "legacy-managed-token",
      createdBy: "techwu",
    });
    const runtime = registerDaemonRuntimesSync({
      daemonKey: "legacy-managed-token",
      deviceName: "Legacy managed runtime",
      daemonTokenId: daemonToken.id,
      metadata: { managedNode: true },
      runtimes: [{ provider: "codex", name: "Legacy managed Codex" }],
    }).runtimes[0]!;
    updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      managedCredentialId: "legacy-managed-credential",
      provisioningState: "managed",
      status: "online",
    });
    createEmployeeSync({ name: "Managed Legacy Atlas", role: "Planner" });
    bindEmployeeRuntimeSync("Managed Legacy Atlas", runtime.id);
    expect(enqueueNativeTaskSync({
      assignee: "Managed Legacy Atlas",
      title: "Must not use a legacy generic token",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Must not use a legacy generic token" },
    })).toBeTruthy();

    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const response = await claimPOST(
      new Request(`http://localhost/api/daemon/runtimes/${runtime.id}/tasks/claim`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId: runtime.id }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Managed runtime execution requires a managed bootstrap token.",
    });

    const heartbeatResponse = await heartbeatPOST(
      new Request("http://localhost/api/daemon/heartbeat", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({ daemonKey: "legacy-managed-token" }),
      }),
    );
    expect(heartbeatResponse.status).toBe(403);
  });

  it("keeps legacy managed runtime records on the local provider path", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "local");
    const daemonToken = createDaemonApiTokenSync({
      label: "local-managed-runtime-daemon",
      createdBy: "techwu",
    });
    const registration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "local-managed-runtime-daemon",
          deviceName: "Local managed runtime daemon",
          runtimes: [{ provider: "codex", name: "Local Codex" }],
        }),
      }),
    );
    const runtimeId = (await registration.json()).runtimes[0].id as string;
    updateAgentRuntimeManagedFieldsSync({ runtimeId, managedCredentialId: "legacy-managed-credential" });
    createEmployeeSync({ name: "Local Atlas", role: "Planner" });
    bindEmployeeRuntimeSync("Local Atlas", runtimeId);
    const queued = enqueueNativeTaskSync({
      assignee: "Local Atlas",
      title: "Local managed runtime compatibility",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Local managed runtime compatibility" },
    });

    const claimed = await claimDaemonTaskForTest(daemonToken.token, runtimeId);
    expect(claimed.id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const bundleResponse = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${queued!.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json();
    expect(bundle.metadata.effectiveModel).toBeUndefined();

    const heartbeatResponse = await heartbeatPOST(
      new Request("http://localhost/api/daemon/heartbeat", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "local-managed-runtime-daemon",
          runtimes: [{
            id: runtimeId,
            provider: "codex",
            metadata: {
              managedCredentialId: "spoofed-managed-credential",
              provisioningState: "managed",
            },
          }],
        }),
      }),
    );
    const heartbeat = await heartbeatResponse.json();
    expect(heartbeat.runtimes[0]?.metadata.managedCredentialId).toBeUndefined();
    expect(heartbeat.runtimes[0]?.metadata.provisioningState).toBeUndefined();

    const credentialBundleResponse = await credentialBundleGET(
      new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/credential-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId }) },
    );
    expect(credentialBundleResponse.status).toBe(409);

    const completeResponse = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued!.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "Local provider response",
          usages: [{
            modelId: "gpt-5",
            runtimeCredentialId: "legacy-managed-credential",
            inputTokens: 10,
            outputTokens: 5,
          }],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    expect(completeResponse.status).toBe(200);
    expect(listTokenUsageSync()).toEqual([]);
  });

  it("does not let one daemon token claim or read another daemon runtime task", async () => {
    const codexToken = createDaemonApiTokenSync({
      label: "codex-container",
      createdBy: "techwu",
    });
    const claudeToken = createDaemonApiTokenSync({
      label: "claude-container",
      createdBy: "techwu",
    });
    const codexRegistration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(codexToken.token),
        body: JSON.stringify({
          daemonKey: "runtime-codex-isolated",
          deviceName: "Codex Container",
          runtimes: [{ provider: "codex", name: "Codex" }],
        }),
      }),
    );
    const claudeRegistration = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(claudeToken.token),
        body: JSON.stringify({
          daemonKey: "runtime-claude-isolated",
          deviceName: "Claude Container",
          runtimes: [{ provider: "claude", name: "Claude" }],
        }),
      }),
    );
    const codexPayload = await codexRegistration.json();
    const claudePayload = await claudeRegistration.json();
    const codexRuntimeId = codexPayload.runtimes[0].id as string;

    expect(codexRegistration.status).toBe(200);
    expect(claudeRegistration.status).toBe(200);
    expect(codexRuntimeId).not.toBe(claudePayload.runtimes[0].id);

    createEmployeeSync({ name: "Atlas", role: "Planner" });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", codexRuntimeId);
    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Isolated runtime task",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Isolated runtime task" },
    });

    const claimResponse = await claimPOST(
      new Request(`http://localhost/api/daemon/runtimes/${codexRuntimeId}/tasks/claim`, {
        method: "POST",
        headers: daemonHeaders(claudeToken.token),
      }),
      { params: Promise.resolve({ runtimeId: codexRuntimeId }) },
    );
    const inputResponse = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/input-bundle`, {
        headers: daemonHeaders(claudeToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(claimResponse.status).toBe(403);
    expect(inputResponse.status).toBe(403);
  });

  it("grants runtimes to the workspace member who created the daemon token", async () => {
    const member = createUserSync({
      primaryEmail: "member-runtime@example.com",
      displayName: "Runtime Member",
    });
    createWorkspaceMembershipSync({
      workspaceId: "default",
      userId: member.id,
      role: "member",
    });
    const daemonToken = createDaemonApiTokenSync({
      label: "member-daemon",
      createdBy: member.id,
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "member-box-1",
          deviceName: "Member Box 1",
          runtimes: [
            {
              provider: "codex",
              name: "Member Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();

    expect(registerResponse.status).toBe(200);
    expect(listRuntimeGrantsSync("default")).toMatchObject([
      {
        runtimeId: registerPayload.runtimes[0].id,
        userId: member.id,
        grantedByUserId: member.id,
        status: "active",
      },
    ]);
  });

  it("registers mixed expanded providers without filtering their ids", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const response = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-2",
          deviceName: "Build Box 2",
          runtimes: [
            {
              provider: "opencode",
              name: "OpenCode Runtime",
              version: "0.1.0",
            },
            {
              provider: "antigravity",
              name: "Antigravity Runtime",
              version: "0.9.0",
            },
            {
              provider: "openclaw",
              name: "OpenClaw Runtime",
              version: "0.2.0",
            },
            {
              provider: "nanobot",
              name: "NanoBot Runtime",
              version: "0.3.0",
            },
            {
              provider: "hermes",
              name: "Hermes Runtime",
              version: "0.4.0",
            },
          ],
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.runtimes).toHaveLength(5);
    expect(
      payload.runtimes
        .map((runtime: { provider: string }) => runtime.provider)
        .sort(),
    ).toEqual(["antigravity", "hermes", "nanobot", "opencode", "openclaw"].sort());
  });

  it("claims a queued task and builds an input bundle with prompt and attachment files", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-2",
          deviceName: "Build Box 2",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const storageKey = "workspaces/default/attachments/att-manual-note/manual-note.txt";
    const storedPath = `tos://test-bucket/${storageKey}`;
    testTos.seed(storageKey, "input attachment");

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Draft itinerary reply",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Draft itinerary reply",
        attachments: [
          {
            fileName: "manual-note.txt",
            storedPath,
            storageProvider: "tos",
            storageBucket: "test-bucket",
            storageRegion: "cn-beijing",
            storageEndpoint: "https://tos-cn-beijing.volces.com",
            storageKey,
            mediaType: "text/plain",
            kind: "file",
          },
        ],
      },
    });

    expect(queued?.id).toBeTruthy();

    const claimResponse = await claimPOST(
      new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId }) },
    );
    const claimPayload = await claimResponse.json();

    expect(claimResponse.status).toBe(200);
    expect(claimPayload.task.id).toBe(queued?.id);
    expect(claimPayload.task.employeeId).toBe(queued?.employeeId);
    expect(claimPayload.task.employeeName).toBe(queued?.employeeName);
    expect(claimPayload.task.agentId).toBe(queued?.employeeId);

    const bundleResponse = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const bundlePayload = await bundleResponse.json();

    expect(bundleResponse.status).toBe(200);
    expect(bundlePayload.taskId).toBe(queued?.id);
    expect(bundlePayload.prompt).toContain("任务标题: Draft itinerary reply");
    expect(bundlePayload.files.some((file: { path: string }) => file.path === "prompt.txt")).toBe(true);
    expect(bundlePayload.files.some((file: { path: string }) => file.path === "task.json")).toBe(true);
    expect(bundlePayload.files.some((file: { path: string }) => file.path === "attachments/01-manual-note.txt")).toBe(true);
    for (const file of bundlePayload.files as Array<{ contentBase64: string; sha256: string; size: number }>) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      expect(file.size).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("includes only installed runtime apps and available runtime app skills in task input bundles", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });
    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-runtime-context",
          deviceName: "Build Box Runtime Context",
          runtimes: [
            {
              provider: "codex",
              name: "Runtime With App",
              version: "test",
            },
            {
              provider: "claude",
              name: "Runtime Without App",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeWithAppId = registerPayload.runtimes.find((runtime: { provider: string }) => runtime.provider === "codex").id as string;
    const runtimeWithoutAppId = registerPayload.runtimes.find((runtime: { provider: string }) => runtime.provider === "claude").id as string;

    upsertRuntimeAppCatalogItemsSync([{
      source: "clihub_harness",
      name: "mermaid",
      displayName: "Mermaid",
      description: "Render diagrams",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
      skillMd: "skills/cli-anything-mermaid/SKILL.md",
      registryJson: "{}",
    }]);
    const operation = createRuntimeAppOperationSync({
      runtimeId: runtimeWithAppId,
      appSource: "clihub_harness",
      appName: "mermaid",
      operation: "install",
      commandPlanJson: JSON.stringify({
        app: { source: "clihub_harness", name: "mermaid", version: "", entryPoint: "mmdc" },
        strategy: "cli_hub",
        commands: [],
        verifyCommands: [],
        risk: "low",
        requiresApproval: true,
        notes: [],
      }),
    });
    completeRuntimeAppOperationSync({
      operationId: operation.id,
      installedApp: {
        displayName: "Mermaid",
        version: "1.0.0",
        entryPoint: "mmdc",
        installStrategy: "cli_hub",
      },
    });
    const skill = createWorkspaceSkillSync({
      name: "clihub-mermaid",
      description: "Mermaid runtime app usage",
      content: "Use `mmdc` only when the bound runtime exposes Mermaid.",
      sourceType: "clihub_runtime_app",
      configJson: JSON.stringify({
        runtimeApp: {
          source: "clihub_harness",
          name: "mermaid",
        },
      }),
    });

    createEmployeeSync({ name: "Atlas", role: "Planner" });
    setEmployeeSkillIdsSync("Atlas", [skill.id]);
    bindEmployeeRuntimeSync("Atlas", runtimeWithAppId);
    const availableTask = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Render a diagram",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Render a diagram" },
    });
    expect(availableTask?.id).toBeTruthy();
    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeWithAppId)).id).toBe(availableTask!.id);
    const availableBundleResponse = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${availableTask?.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: availableTask!.id }) },
    );
    const availableBundle = await availableBundleResponse.json();

    expect(availableBundleResponse.status).toBe(200);
    expect(availableBundle.metadata.runtimeApps.status).toBe("available");
    expect(availableBundle.metadata.runtimeApps.apps[0].name).toBe("mermaid");
    expect(availableBundle.metadata.runtimeToolCapabilities.status).toBe("available");
    expect(availableBundle.metadata.runtimeToolCapabilities.capabilities[0]).toMatchObject({
      id: "clihub:clihub_harness:mermaid",
      command: "mmdc",
      source: "cli-hub",
    });
    expect(availableBundle.prompt).toContain("当前绑定 runtime 已安装并启用的 CLI-Hub runtime apps: 1 个。");
    expect(availableBundle.prompt).toContain("SKILL.md: skills/cli-anything-mermaid/SKILL.md");
    expect(availableBundle.files.some((file: { path: string }) => file.path.includes("clihub-mermaid"))).toBe(true);

    unbindEmployeeRuntimeSync("Atlas");
    bindEmployeeRuntimeSync("Atlas", runtimeWithoutAppId);
    const unavailableTask = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Try diagram elsewhere",
      priority: "medium",
      triggerType: "manual",
      metadata: { title: "Try diagram elsewhere" },
    });
    expect(unavailableTask?.id).toBeTruthy();
    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeWithoutAppId)).id).toBe(unavailableTask!.id);
    const unavailableBundleResponse = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${unavailableTask?.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: unavailableTask!.id }) },
    );
    const unavailableBundle = await unavailableBundleResponse.json();

    expect(unavailableBundleResponse.status).toBe(200);
    expect(unavailableBundle.metadata.runtimeApps.status).toBe("none");
    expect(unavailableBundle.metadata.runtimeToolCapabilities.status).toBe("available");
    expect(unavailableBundle.metadata.runtimeToolCapabilities.capabilities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "clihub:clihub_harness:mermaid" }),
      ]),
    );
    expect(unavailableBundle.prompt).toContain("当前绑定 runtime 未报告已安装的 CLI-Hub runtime app");
    expect(unavailableBundle.files.some((file: { path: string }) => file.path.includes("clihub-mermaid"))).toBe(false);
  });

  it("claims and completes runtime app operations through daemon routes", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-apps",
          deviceName: "Build Box Apps",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    upsertRuntimeAppCatalogItemsSync([{
      source: "clihub_harness",
      name: "mermaid",
      displayName: "Mermaid",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
      registryJson: "{}",
    }]);
    const operation = createRuntimeAppOperationSync({
      runtimeId,
      appSource: "clihub_harness",
      appName: "mermaid",
      operation: "install",
      commandPlanJson: JSON.stringify({
        app: { source: "clihub_harness", name: "mermaid", version: "", entryPoint: "mmdc" },
        strategy: "cli_hub",
        commands: [{ executable: "cli-hub", args: ["install", "mermaid"] }],
        verifyCommands: [],
        risk: "low",
        requiresApproval: true,
        notes: [],
      }),
    });

    const claimResponse = await appOperationClaimPOST(
      new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/apps/operations/claim`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ runtimeId }) },
    );
    const claimPayload = await claimResponse.json();

    expect(claimResponse.status).toBe(200);
    expect(claimPayload.operation.id).toBe(operation.id);
    expect(claimPayload.operation.commandPlan.commands[0].executable).toBe("cli-hub");

    const startResponse = await appOperationStartPOST(
      new Request(`http://localhost/api/daemon/runtime-app-operations/${operation.id}/start`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ operationId: operation.id }) },
    );
    expect(startResponse.status).toBe(200);

    const stageResponse = await appOperationStagePOST(
      new Request(`http://localhost/api/daemon/runtime-app-operations/${operation.id}/stage`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({ stage: "verifying" }),
      }),
      { params: Promise.resolve({ operationId: operation.id }) },
    );
    expect(stageResponse.status).toBe(200);
    expect((await stageResponse.json()).operation.stage).toBe("verifying");

    const completeResponse = await appOperationCompletePOST(
      new Request(`http://localhost/api/daemon/runtime-app-operations/${operation.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          safeStdoutTail: "installed",
          installedApp: {
            displayName: "Mermaid",
            version: "1.0.0",
            entryPoint: "mmdc",
            installStrategy: "cli_hub",
          },
        }),
      }),
      { params: Promise.resolve({ operationId: operation.id }) },
    );
    const completePayload = await completeResponse.json();

    expect(completeResponse.status).toBe(200);
    expect(completePayload.operation.status).toBe("succeeded");
    const installed = listRuntimeInstalledAppsSync({ runtimeId });
    expect(installed[0]?.status).toBe("installed");
    expect(installed[0]?.entryPoint).toBe("mmdc");
  });

  it("records failed runtime app operation details through daemon routes", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });
    const snapshot = registerDaemonRuntimesSync({
      daemonTokenId: daemonToken.id,
      daemonKey: "build-box-app-failure",
      deviceName: "Build Box Failure",
      runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
    });
    const runtimeId = snapshot.runtimes[0]!.id;
    const operation = createRuntimeAppOperationSync({
      runtimeId,
      appSource: "clihub_harness",
      appName: "missing",
      operation: "install",
      commandPlanJson: JSON.stringify({
        app: { source: "clihub_harness", name: "missing", version: "", entryPoint: "" },
        strategy: "cli_hub",
        commands: [],
        verifyCommands: [],
        risk: "low",
        requiresApproval: true,
        notes: [],
      }),
    });

    const failResponse = await appOperationFailPOST(
      new Request(`http://localhost/api/daemon/runtime-app-operations/${operation.id}/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          errorCode: "runtime_app.command_failed",
          errorMessage: "cli-hub exited with code 1",
          safeStderrTail: "not found",
        }),
      }),
      { params: Promise.resolve({ operationId: operation.id }) },
    );
    const failPayload = await failResponse.json();

    expect(failResponse.status).toBe(200);
    expect(failPayload.operation.status).toBe("failed");
    expect(failPayload.operation.errorMessage).toBe("cli-hub exited with code 1");
  });

  it("does not hand the same queued task to concurrent claim requests", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-2b",
          deviceName: "Build Box 2B",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Concurrent claim task",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Concurrent claim task",
      },
    });

    expect(queued?.id).toBeTruthy();

    const [firstResponse, secondResponse] = await Promise.all([
      claimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      ),
      claimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/tasks/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      ),
    ]);

    const [firstPayload, secondPayload] = await Promise.all([firstResponse.json(), secondResponse.json()]);
    const claimedIds = [firstPayload.task?.id, secondPayload.task?.id].filter(Boolean);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(claimedIds).toEqual([queued?.id]);
  });

  it("creates and reads runtime tool approvals for daemon tasks", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-approval",
          deviceName: "Build Box Approval",
          runtimes: [
            {
              provider: "claude",
              name: "Remote Claude",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Needs tool approval",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Needs tool approval",
        channel: "tour visit",
      },
    });

    const createResponse = await runtimeApprovalPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/runtime-approvals`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          provider: "claude",
          runtimeId,
          sessionId: "session-1",
          toolName: "Bash",
          toolInput: { command: "acme-tool +read --help" },
          contentPreview: "Bash: acme-tool +read --help",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const createPayload = await createResponse.json();

    expect(createResponse.status).toBe(200);
    expect(createPayload.approval.status).toBe("pending");

    const readResponse = await runtimeApprovalGET(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/runtime-approvals/${createPayload.approval.approvalId}`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id, approvalId: createPayload.approval.approvalId }) },
    );
    const readPayload = await readResponse.json();

    expect(readResponse.status).toBe(200);
    expect(readPayload.approval.approvalId).toBe(createPayload.approval.approvalId);
    expect(readPayload.approval.status).toBe("pending");

    const workspaceState = readWorkspaceStateSync();
    const approval = workspaceState.approvals.find((item) => item.id === createPayload.approval.approvalId);
    expect(approval?.type).toBe("runtime_tool");
    expect(approval?.metadata?.toolName).toBe("Bash");

    cancelQueuedTaskSync({ taskId: queued!.id, errorText: "Stopped by user." });
    reviewApprovalSync(createPayload.approval.approvalId, "rejected");
    expect(readWorkspaceStateSync().messages.some((message) =>
      message.data?.approval_id === createPayload.approval.approvalId
    )).toBe(false);

    const lateCreateResponse = await runtimeApprovalPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/runtime-approvals`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          provider: "claude",
          runtimeId,
          sessionId: "session-1",
          toolName: "WebSearch",
          toolInput: { query: "late approval" },
          contentPreview: "WebSearch: late approval",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(lateCreateResponse.status).toBe(409);
    expect(await lateCreateResponse.json()).toEqual({
      error: "Runtime approval cannot be created for a cancelled task.",
      errorCode: "task_cancelled",
    });
    expect(readWorkspaceStateSync().approvals.filter((item) => item.sourceId === queued!.id)).toHaveLength(1);
  });

  it("requires identity before Feishu external guests can approve runtime tools", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-feishu-guest-runtime-approval",
          deviceName: "Build Box Feishu Guest Runtime Approval",
          runtimes: [
            {
              provider: "claude",
              name: "Remote Claude",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    const feishuIntegration = createExternalIntegrationSync({
      workspaceId: "default",
      provider: "feishu",
      displayName: "Atlas Feishu Bot",
      transportMode: "websocket_worker",
      agentId: "Atlas",
      appId: "cli_atlas_feishu_runtime_guest",
    });

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Feishu guest needs tool approval",
      priority: "medium",
      triggerType: "mention_chat",
      metadata: {
        title: "Feishu guest needs tool approval",
        channel: "tour visit",
        channelName: "tour visit",
        externalInput: {
          provider: "feishu",
          providerLabel: "Feishu/Lark",
          externalEventId: "evt-feishu-runtime-guest",
          externalMessageId: "om-feishu-runtime-guest",
          externalChatId: "oc-feishu-runtime-guest",
          trust: "untrusted_user_message",
          actor: {
            actorType: "external_guest",
            externalActorReference: "a".repeat(64),
            externalGuestPermissionProfile: "channel_context_only",
            externalGuestRequireIdentityFor: ["writes", "approvals", "runtime_sensitive_tools"],
            agentId: "Atlas",
            botBindingId: feishuIntegration.id,
          },
        },
      },
    });

    const createResponse = await runtimeApprovalPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/runtime-approvals`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          provider: "claude",
          runtimeId,
          sessionId: "session-guest-1",
          toolName: "Bash",
          toolInput: { command: "acme-tool +write launch-plan" },
          contentPreview: "Bash: acme-tool +write launch-plan",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const createPayload = await createResponse.json();

    expect(createResponse.status).toBe(403);
    expect(createPayload).toMatchObject({
      errorCode: "feishu.runtime_tool_external_guest_requires_identity",
      reasonCode: "feishu_external_guest_runtime_sensitive_tool_identity_required",
      requireIdentity: true,
      actorType: "external_guest",
      externalActorReference: "a".repeat(64),
      identityNoticeQueued: true,
    });
    expect(readWorkspaceStateSync().approvals.some((approval) => approval.type === "runtime_tool")).toBe(false);
    const outbox = listPendingExternalMessageOutboxSync({
      workspaceId: "default",
      integrationId: feishuIntegration.id,
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.targetExternalChatId).toBe("oc-feishu-runtime-guest");
    expect(outbox[0]?.targetExternalThreadId).toBe("om-feishu-runtime-guest");
    expect(outbox[0]?.payloadJson).toContain("identity required");
    expect(outbox[0]?.payloadJson).not.toContain("a".repeat(64));
  });

  it("completes a task with an output bundle and writes attachments back into workspace messages", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-3",
          deviceName: "Build Box 3",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Draft reply",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Draft reply",
        channel: "tour visit",
      },
    });

    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const outputBundleResponse = await outputBundlePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/output-bundle`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          version: 1,
          format: "json-inline-v1",
          files: [
            {
              path: "runtime-output/agent-output.json",
              contentBase64: Buffer.from(
                JSON.stringify({
                  text: "图表已生成。",
                  attachments: [
                    {
                      path: "runtime-output/artifacts/chart.png",
                      name: "chart.png",
                      mediaType: "image/png",
                    },
                  ],
                }),
                "utf8",
              ).toString("base64"),
            },
            {
              path: "runtime-output/artifacts/chart.png",
              contentBase64: Buffer.from("fake-image-content", "utf8").toString("base64"),
            },
          ],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(outputBundleResponse.status).toBe(202);
    expect(listTaskExecutionEventsSync({ taskId: queued!.id }).some((event) => event.type === "artifact_detected")).toBe(true);

    const completeResponse = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "图表已生成。",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const completePayload = await completeResponse.json();

    expect(completeResponse.status).toBe(200);
    expect(completePayload.task.status).toBe("completed");

    const state = readWorkspaceStateSync();
    expect(state.messages[0]?.summary).toBe("图表已生成。");
    expect(state.messages[0]?.attachments?.[0]?.fileName).toBe("chart.png");
    const timelineTypes = listTaskExecutionEventsSync({ taskId: queued!.id }).map((event) => event.type);
    expect(timelineTypes).toContain("artifact_collected");
    expect(timelineTypes).toContain("completed");

    const attachment = state.messages[0]?.attachments?.[0];
    expect(attachment).toBeDefined();
    const eventCount = timelineTypes.length;
    const lateComplete = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued!.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "tampered",
          outputBundle: {
            version: 1,
            format: "json-inline-v1",
            files: [{
              path: "runtime-output/artifacts/chart.png",
              contentBase64: Buffer.from("tampered-image", "utf8").toString("base64"),
            }],
          },
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    await expect(lateComplete.json()).resolves.toMatchObject({
      task: { id: queued!.id, status: "completed" },
      ignored: true,
    });
    const lateUpload = await outputBundlePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued!.id}/output-bundle`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          version: 1,
          format: "json-inline-v1",
          files: [{
            path: "runtime-output/artifacts/chart.png",
            contentBase64: Buffer.from("tampered-image", "utf8").toString("base64"),
          }],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    await expect(lateUpload.json()).resolves.toMatchObject({
      task: { id: queued!.id, status: "completed" },
      ignored: true,
    });
    expect(Buffer.from(readWorkspaceAttachmentBytesSync(attachment!)).toString("utf8")).toBe("fake-image-content");
    expect(listTaskExecutionEventsSync({ taskId: queued!.id })).toHaveLength(eventCount);
  });

  it("processes Feishu lark-cli result manifests into data operation evidence", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-feishu-lark-cli-result",
          deviceName: "Build Box Feishu Lark CLI Result",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const integration = createExternalIntegrationSync({
      provider: "feishu",
      displayName: "Feishu",
      transportMode: "http_webhook",
      appId: "cli_test",
      encryptedCredentialsJson: {},
      configJson: {},
      capabilitiesJson: {},
      scopesJson: [],
    });
    const resourceBinding = upsertExternalResourceBindingSync({
      integrationId: integration.id,
      providerResourceType: "doc",
      providerResourceToken: "doccnRoute123",
      providerResourceUrl: "https://example.feishu.cn/docx/doccnRoute123",
      dofeAgentResourceType: "channel_document",
      dofeAgentResourceId: "channel-document-feishu-doc",
      channelName: "tour visit",
      displayName: "Quarterly Roadmap",
      permissionsJson: {
        canWrite: false,
      },
      metadataJson: {},
    });

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Read Feishu doc",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Read Feishu doc",
        channel: "tour visit",
        channelName: "tour visit",
      },
    });

    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const outputBundleResponse = await outputBundlePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/output-bundle`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          version: 1,
          format: "json-inline-v1",
          files: [
            {
              path: FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH,
              contentBase64: Buffer.from(
                JSON.stringify({
                  kind: FEISHU_LARK_CLI_RESULT_MANIFEST_KIND,
                  schemaVersion: 1,
                  ok: true,
                  operationType: "docs.read_document",
                  providerResourceType: "doc",
                  providerResourceToken: "doccnRoute123",
                  responseSummary: "Fetched Quarterly Roadmap content.",
                  data: {
                    documentId: "doccnRoute123",
                    blockCount: 8,
                  },
                }),
                "utf8",
              ).toString("base64"),
            },
          ],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(outputBundleResponse.status).toBe(202);

    const completeResponse = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "已读取飞书文档。",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const completePayload = await completeResponse.json();

    expect(completeResponse.status).toBe(200);
    expect(completePayload.task.status).toBe("completed");

    const runs = listExternalDataOperationRunsSync({
      workspaceId: "default",
      integrationId: integration.id,
      resourceBindingId: resourceBinding.id,
      limit: 5,
    });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      status: "succeeded",
      operationType: "docs.read_document",
      providerResourceType: "doc",
      providerResourceToken: "doccnRoute123",
      actorType: "agent",
      actorId: "Atlas",
    });
    const resultJson = JSON.parse(run.resultJson) as {
      responseSummaryRedacted?: boolean;
      runtimeResultManifest?: {
        path?: string;
      };
    };
    expect(resultJson.responseSummaryRedacted).toBe(true);
    expect(resultJson.runtimeResultManifest?.path).toBe(FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH);
    expect(JSON.stringify(resultJson)).not.toContain("Quarterly Roadmap");
    expect(JSON.stringify(resultJson)).not.toContain("doccnRoute123");

    const completedTask = readQueuedTaskSync(queued!.id);
    expect(completedTask?.resultJson).toBeTruthy();
    const taskResult = JSON.parse(completedTask!.resultJson!) as {
      feishuLarkCliDataOperationRunIds?: string[];
    };
    expect(taskResult.feishuLarkCliDataOperationRunIds).toEqual([run.id]);
  });

  it("rejects output bundles that try to escape the staging directory", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-4",
          deviceName: "Build Box 4",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Bad bundle",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Bad bundle",
      },
    });

    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const response = await outputBundlePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/output-bundle`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          version: 1,
          format: "json-inline-v1",
          files: [
            {
              path: "../escape.txt",
              contentBase64: Buffer.from("bad", "utf8").toString("base64"),
            },
          ],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/invalid output bundle path/i);
  });

  it("rejects output bundles outside runtime-output", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-runtime-output-only",
          deviceName: "Build Box Runtime Output Only",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "Bad bundle prefix",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Bad bundle prefix",
      },
    });

    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const response = await outputBundlePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/output-bundle`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          version: 1,
          format: "json-inline-v1",
          files: [
            {
              path: "artifacts/chart.png",
              contentBase64: Buffer.from("bad", "utf8").toString("base64"),
            },
          ],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/runtime-output/i);
  });

  it("rejects cross-workspace task reads for daemon tokens and records an audit entry", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "default-daemon",
      createdBy: "techwu",
    });

    if (!readWorkspaceSync("workspace-mars")) {
      createWorkspaceSync({
        id: "workspace-mars",
        slug: "workspace-mars",
        name: "Mars Workspace",
        createdBy: "techwu",
      });
    }
    resetWorkspaceStateSync("workspace-mars");
    const marsSnapshot = registerDaemonRuntimesSync({
      workspaceId: "workspace-mars",
      daemonKey: "mars-box-1",
      deviceName: "Mars Box 1",
      runtimes: [
        {
          provider: "codex",
          name: "Mars Codex",
          version: "test",
        },
      ],
    });
    const marsRuntimeId = marsSnapshot.runtimes[0]?.id as string;

    createEmployeeSync({
      name: "Nova",
      role: "Planner",
    }, "workspace-mars");
    bindEmployeeRuntimeSync("Nova", marsRuntimeId, "workspace-mars");

    const queued = enqueueNativeTaskSync({
      workspaceId: "workspace-mars",
      assignee: "Nova",
      title: "Mars only task",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "Mars only task",
      },
    });

    expect(queued?.id).toBeTruthy();

    const response = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Task does not belong to this workspace." });
    expect(readWorkspaceStateSync().ledger[0]).toMatchObject({
      code: "workspace.cross_workspace_access_denied",
      data: expect.objectContaining({
        actorType: "daemon_token",
        resourceType: "task",
        resourceId: queued!.id,
        requestedWorkspaceId: "workspace-mars",
      }),
    });
  });

  it("rejects input bundle when assigned skill requirements are not satisfied", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "skill-readiness-box",
          deviceName: "Skill Readiness Box",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const skill = createWorkspaceSkillSync({
      name: `notion-sync-${randomUUID()}`,
      description: "Requires NOTION_DATABASE_ID",
      configJson: JSON.stringify({
        requirements: [{ kind: "config", value: "NOTION_DATABASE_ID" }],
      }),
    });
    setEmployeeSkillIdsSync("Atlas", [skill.id]);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "sync notion",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "sync notion",
      },
    });
    expect(queued?.id).toBeTruthy();

    const response = await inputBundleGET(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/input-bundle`, {
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toMatch(/skill requirements are not satisfied/i);
    expect(payload.error).toContain("NOTION_DATABASE_ID");
    expect(payload.code).toBe("skill_requirements_unsatisfied");
    expect(payload.skillReadinessBlockers).toEqual(
      expect.arrayContaining([expect.stringContaining("NOTION_DATABASE_ID")]),
    );
  });

  it("keeps task state stable when start and fail are called repeatedly", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-7",
          deviceName: "Build Box 7",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);

    const queued = enqueueNativeTaskSync({
      assignee: "Atlas",
      title: "retry me",
      priority: "medium",
      triggerType: "manual",
      metadata: {
        title: "retry me",
        channel: "tour visit",
      },
    });
    expect(queued?.id).toBeTruthy();

    const firstStart = await startPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/start`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const secondStart = await startPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/start`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);

    const firstFail = await failPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          errorText: "temporary failure",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    const secondFail = await failPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          errorText: "temporary failure",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(firstFail.status).toBe(200);
    expect(secondFail.status).toBe(200);

    const queuedTask = listQueuedTasksSync().find((task) => task.id === queued?.id);
    expect(queuedTask?.status).toBe("failed");
  });

  it("does not post daemon start notices into direct-contact conversations", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-direct-start",
          deviceName: "Build Box Direct Start",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    sendContactMessageSync("Atlas", "帮我整理一下大阪行程。");

    const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas" && task.triggerType === "channel_chat");
    expect(queued?.id).toBeTruthy();

    const beforeState = readWorkspaceStateSync();
    const directChannelName = beforeState.channels.find(
      (channel) => channel.kind === "direct" && channel.employeeNames.some((name) => name === "Atlas"),
    )?.name;
    expect(directChannelName).toBeTruthy();
    const beforeMessageCount = beforeState.messages.filter((message) => message.channel === directChannelName).length;

    const response = await startPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/start`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(response.status).toBe(200);
    const afterMessages = readWorkspaceStateSync().messages.filter((message) => message.channel === directChannelName);
    expect(afterMessages).toHaveLength(beforeMessageCount);
    expect(afterMessages.some((message) => message.summary.includes("开始执行"))).toBe(false);
    expect(listTaskExecutionEventsSync({ taskId: queued!.id }).some((event) => event.type === "workspace_prepared")).toBe(true);
  });

  it("completes a remote direct-channel task and replaces the pending channel reply", async () => {
    vi.stubEnv("DOFE_AGENT_RUNTIME_MODE", "remote");
    const daemonToken = createManagedDaemonBootstrapTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-5",
          deviceName: "Build Box 5",
          metadata: { managedNode: true },
          runtimes: [],
        }),
      }),
    );
    expect(registerResponse.status).toBe(200);
    const managedRuntime = registerDaemonRuntimesSync({
      daemonKey: "build-box-5",
      deviceName: "Build Box 5",
      daemonTokenId: daemonToken.id,
      metadata: { managedNode: true },
      runtimes: [{ provider: "codex", name: "Managed Codex", version: "test" }],
    }).runtimes[0];
    expect(managedRuntime).toBeTruthy();
    const runtimeId = managedRuntime!.id;
    updateAgentRuntimeManagedFieldsSync({
      runtimeId,
      managedCredentialId: "runtime-credential-direct",
      provisioningState: "managed",
      status: "online",
    });

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    sendContactMessageSync("Atlas", "帮我整理一下大阪行程。");

    const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas" && task.triggerType === "channel_chat");
    expect(queued?.id).toBeTruthy();
    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const invalidUsageResponse = await usagePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/usage`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          usages: [{
            modelId: "gpt-5.4",
            runtimeCredentialId: "runtime-credential-direct",
            gatewayRequestId: "gateway-request-fractional",
            inputTokens: 1.5,
            outputTokens: 1,
          }],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    expect(invalidUsageResponse.status).toBe(400);

    const incrementalUsageResponse = await usagePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/usage`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          usages: [{
            modelId: "gpt-5.4",
            runtimeCredentialId: "runtime-credential-direct",
            gatewayRequestId: "gateway-request-direct-1",
            inputTokens: 120,
            outputTokens: 45,
          }],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );
    expect(incrementalUsageResponse.status).toBe(200);
    await expect(incrementalUsageResponse.json()).resolves.toEqual({
      accepted: 1,
      pendingReconciliation: false,
    });
    expect(listTokenUsageSync()).toHaveLength(1);
    expect(listTokenUsageSync()[0]).toMatchObject({
      taskQueueId: queued!.id,
      employeeId: queued!.employeeId,
      runtimeId,
      sourceInvocationId: "gateway-request-direct-1",
    });

    const completeResponse = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "我先给你一版大阪行程草案。",
          usages: [
            {
              modelId: "gpt-5.4",
              runtimeCredentialId: "runtime-credential-direct",
              gatewayRequestId: "gateway-request-direct-1",
              inputTokens: 120,
              outputTokens: 45,
            },
            {
              modelId: "gpt-5.4",
              runtimeCredentialId: "runtime-credential-direct",
              gatewayRequestId: "gateway-request-direct-2",
              inputTokens: 30,
              outputTokens: 10,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(completeResponse.status).toBe(200);
    expect(listTokenUsageSync()).toHaveLength(2);
    const state = readWorkspaceStateSync();
    const directChannel = state.channels.find(
      (channel) => channel.kind === "direct" && channel.employeeNames.some((name) => name === "Atlas"),
    );
    expect(directChannel?.name).toBeTruthy();
    const channelMessages = state.messages.filter((message) => message.channel === directChannel?.name);
    expect(channelMessages.some((message) => message.role === "agent" && message.status === "pending")).toBe(false);
    expect(channelMessages[0]?.summary).toBe("我先给你一版大阪行程草案。");
    expect(listTokenUsageSync().find((usage) => usage.gatewayRequestId === "gateway-request-direct-1")).toMatchObject({
      taskQueueId: queued!.id,
      agentId: queued!.employeeId,
      modelId: "gpt-5.4",
      runtimeCredentialId: "runtime-credential-direct",
      inputTokens: 120,
      outputTokens: 45,
    });
    expect(listTokenUsageSync().find((usage) => usage.gatewayRequestId === "gateway-request-direct-2")).toMatchObject({
      taskQueueId: queued!.id,
      inputTokens: 30,
      outputTokens: 10,
    });
  });

  it("labels remote direct-channel task failures as direct conversations", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-direct-fail",
          deviceName: "Build Box Direct Fail",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    sendContactMessageSync("Atlas", "帮我整理一下大阪行程。");

    const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas" && task.triggerType === "channel_chat");
    expect(queued?.id).toBeTruthy();

    const failResponse = await failPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          errorText: "temporary failure",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(failResponse.status).toBe(200);
    const state = readWorkspaceStateSync();
    const directChannel = state.channels.find(
      (channel) => channel.kind === "direct" && channel.employeeNames.some((name) => name === "Atlas"),
    );
    const channelMessages = state.messages.filter((message) => message.channel === directChannel?.name);
    expect(channelMessages[0]?.summary).toContain("在私聊");
    expect(channelMessages[0]?.summary).not.toContain("在群聊");
  });

  it("queues a Feishu outbox reply when a remote mention_chat task fails", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-feishu-fail",
          deviceName: "Build Box Feishu Fail",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    addChannelEmployeesSync({ channelName: "tour visit", employeeNames: ["Atlas"] });
    sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas 请补全大阪行程安排。");
    const sourceMessage = readWorkspaceStateSync().messages.find(
      (message) =>
        message.channel === "tour visit" &&
        message.role === "human" &&
        message.summary === "@Atlas 请补全大阪行程安排。",
    );
    expect(sourceMessage?.id).toBeTruthy();

    const integration = createExternalIntegrationSync({
      provider: "feishu",
      displayName: "Feishu",
      transportMode: "http_webhook",
      appId: "cli_test",
      encryptedCredentialsJson: {},
      configJson: {},
      capabilitiesJson: {},
      scopesJson: [],
    });
    const channelBinding = upsertExternalChannelBindingSync({
      integrationId: integration.id,
      channelName: "tour visit",
      externalChatId: "oc_tour",
      externalChatType: "group",
      externalChatName: "tour visit",
      status: "active",
      syncMode: "mirror",
    });
    createExternalMessageMappingSync({
      integrationId: integration.id,
      channelBindingId: channelBinding.id,
      direction: "inbound",
      externalMessageId: "om_source",
      externalThreadId: "om_root",
      externalSenderId: "ou_techwu",
      dofeAgentMessageId: sourceMessage!.id,
      metadataJson: {},
    });

    const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas" && task.triggerType === "mention_chat");
    expect(queued?.id).toBeTruthy();

    const failResponse = await failPOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/fail`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          errorText: "temporary failure",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(failResponse.status).toBe(200);
    const outbox = listPendingExternalMessageOutboxSync({
      integrationId: integration.id,
      limit: 10,
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.channelBindingId).toBe(channelBinding.id);
    expect(outbox[0]?.dofeAgentMessageId).toBeUndefined();
    expect(outbox[0]?.targetExternalChatId).toBe("oc_tour");
    expect(outbox[0]?.targetExternalThreadId).toBe("om_root");
    const outboundPayload = JSON.parse(outbox[0]!.payloadJson) as {
      reply_to_message_id?: string;
      content?: string;
    };
    expect(outboundPayload.reply_to_message_id).toBe("om_root");
    expect(JSON.parse(outboundPayload.content ?? "{}").text).toContain("temporary failure");
  });

  it("completes a remote mention_chat task and replaces the pending channel reply", async () => {
    const daemonToken = createDaemonApiTokenSync({
      label: "remote-daemon",
      createdBy: "techwu",
    });

    const registerResponse = await registerPOST(
      new Request("http://localhost/api/daemon/register", {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          daemonKey: "build-box-6",
          deviceName: "Build Box 6",
          runtimes: [
            {
              provider: "codex",
              name: "Remote Codex",
              version: "test",
            },
          ],
        }),
      }),
    );
    const registerPayload = await registerResponse.json();
    const runtimeId = registerPayload.runtimes[0].id as string;

    createEmployeeSync({
      name: "Atlas",
      role: "Planner",
    });
    createEmployeeSync({
      name: "Nova",
      role: "Reviewer",
    });
    bindEmployeeRuntimeSync("Atlas", runtimeId);
    bindEmployeeRuntimeSync("Nova", runtimeId);
    const stateWithMembership = readWorkspaceStateSync();
    const atlas = stateWithMembership.activeEmployees.find((employee) => employee.name === "Atlas");
    if (atlas) {
      atlas.channels = ["tour visit"];
    }
    const nova = stateWithMembership.activeEmployees.find((employee) => employee.name === "Nova");
    if (nova) {
      nova.channels = ["tour visit"];
    }
    stateWithMembership.channels = stateWithMembership.channels.map((channel) =>
      channel.name === "tour visit"
        ? {
            ...channel,
            employeeNames: ["Atlas", "Nova"],
          }
        : channel,
    );
    writeWorkspaceStateSync(stateWithMembership);
    sendChannelHumanMessageSync("tour visit", "techwu", "@Atlas 请补全大阪行程安排。");
    const sourceMessage = readWorkspaceStateSync().messages.find(
      (message) =>
        message.channel === "tour visit" &&
        message.role === "human" &&
        message.summary === "@Atlas 请补全大阪行程安排。",
    );
    expect(sourceMessage?.id).toBeTruthy();

    const integration = createExternalIntegrationSync({
      provider: "feishu",
      displayName: "Feishu",
      transportMode: "http_webhook",
      appId: "cli_test",
      encryptedCredentialsJson: {},
      configJson: {},
      capabilitiesJson: {},
      scopesJson: [],
    });
    const channelBinding = upsertExternalChannelBindingSync({
      integrationId: integration.id,
      channelName: "tour visit",
      externalChatId: "oc_tour",
      externalChatType: "group",
      externalChatName: "tour visit",
      status: "active",
      syncMode: "mirror",
    });
    createExternalMessageMappingSync({
      integrationId: integration.id,
      channelBindingId: channelBinding.id,
      direction: "inbound",
      externalMessageId: "om_source",
      externalThreadId: "om_root",
      externalSenderId: "ou_techwu",
      dofeAgentMessageId: sourceMessage!.id,
      metadataJson: {},
    });

    const queued = listQueuedTasksSync().find((task) => task.agentId === "Atlas" && task.triggerType === "mention_chat");
    expect(queued?.id).toBeTruthy();
    expect((await claimDaemonTaskForTest(daemonToken.token, runtimeId)).id).toBe(queued!.id);
    await startDaemonTaskForTest(daemonToken.token, queued!.id);

    const completeResponse = await completePOST(
      new Request(`http://localhost/api/daemon/tasks/${queued?.id}/complete`, {
        method: "POST",
        headers: daemonHeaders(daemonToken.token),
        body: JSON.stringify({
          outputText: "@Nova 我已经补全了大阪段的安排，请你继续检查预算。",
        }),
      }),
      { params: Promise.resolve({ taskId: queued!.id }) },
    );

    expect(completeResponse.status).toBe(200);
    const messages = readWorkspaceStateSync().messages.filter((message) => message.channel === "tour visit");
    expect(messages.some((message) => message.speaker === "Atlas" && message.status === "pending")).toBe(false);
    expect(messages.some((message) => message.speaker === "Nova" && message.status === "pending")).toBe(true);
    const atlasReply = messages.find((message) => message.speaker === "Atlas" && message.status === "completed");
    expect(atlasReply?.summary).toBe("@Nova 我已经补全了大阪段的安排，请你继续检查预算。");
    expect(atlasReply?.mentions?.[0]).toMatchObject({ mentionType: "agent", token: "Nova" });
    const novaQueued = listQueuedTasksSync().find((task) => task.agentId === "Nova" && task.triggerType === "mention_chat");
    expect(novaQueued).toBeTruthy();
    const payload = JSON.parse(novaQueued!.inputJson) as {
      mentionSource?: string;
      initiatorAgentId?: string;
      sourceMessageId?: string;
      sourceTaskQueueId?: string;
      channelMessage?: string;
    };
    expect(payload.mentionSource).toBe("agent_output");
    expect(payload.initiatorAgentId).toBe("Atlas");
    expect(payload.sourceMessageId).toBe(atlasReply?.id);
    expect(payload.sourceTaskQueueId).toBe(queued?.id);
    expect(payload.channelMessage).toBe("@Nova 我已经补全了大阪段的安排，请你继续检查预算。");

    const outbox = listPendingExternalMessageOutboxSync({
      integrationId: integration.id,
      limit: 10,
    });
    expect(outbox).toHaveLength(2);
    for (const item of outbox) {
      expect(item.channelBindingId).toBe(channelBinding.id);
      expect(item.dofeAgentMessageId).toBe(atlasReply?.id);
      expect(item.targetExternalChatId).toBe("oc_tour");
      expect(item.targetExternalThreadId).toBe("om_root");
    }
    const outboundPayloads = outbox.map((item) => JSON.parse(item.payloadJson) as {
      receive_id_type?: string;
      receive_id?: string;
      reply_to_message_id?: string;
      msg_type?: string;
      content?: string;
    });
    const textPayload = outboundPayloads.find((payload) => payload.msg_type === "text");
    const cardPayload = outboundPayloads.find((payload) => payload.msg_type === "interactive");
    expect(textPayload).toBeTruthy();
    expect(cardPayload).toBeTruthy();
    for (const payloadItem of outboundPayloads) {
      expect(payloadItem.receive_id_type).toBe("chat_id");
      expect(payloadItem.receive_id).toBe("oc_tour");
      expect(payloadItem.reply_to_message_id).toBe("om_root");
    }
    expect(JSON.parse(textPayload?.content ?? "{}")).toMatchObject({
      text: "@Nova 我已经补全了大阪段的安排，请你继续检查预算。",
    });
    expect(cardPayload?.content).toContain("Atlas");
  });

  describe("skill service operation routes", () => {
    function seedSkillServiceOperation(
      daemonTokenId: string,
      daemonKey: string,
      operationType: "provision" | "retire" = "provision",
    ) {
      const snapshot = registerDaemonRuntimesSync({
        daemonTokenId,
        daemonKey,
        deviceName: "Build Box Service",
        runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
      });
      const runtimeId = snapshot.runtimes[0]!.id;
      const catalog = upsertSkillServiceCatalogSync({
        workspaceId: "default",
        slug: "route-renderer",
        templateVersion: "1.0.0",
        deploymentType: "managed_service",
        imageDigest: `sha256:${"a".repeat(64)}`,
        protocol: "http",
        networkJson: JSON.stringify({ ingress: "private" }),
      });
      const managed = createManagedSkillServiceSync({
        workspaceId: "default",
        runtimeId,
        catalogId: catalog.id,
        status: operationType === "retire" ? "ready" : "provisioning",
      });
      const operation = createManagedSkillServiceOperationSync({
        workspaceId: "default",
        runtimeId,
        serviceId: managed.id,
        operation: operationType,
      });
      return { runtimeId, serviceId: managed.id, operationId: operation.id };
    }

    it("claims, starts, renews, and completes a managed service provision through the daemon routes", async () => {
      const daemonToken = createDaemonApiTokenSync({ label: "remote-daemon", createdBy: "techwu" });
      const { runtimeId, serviceId, operationId } = seedSkillServiceOperation(daemonToken.id, "build-box-svc-provision");

      const claimResponse = await skillServiceClaimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/skill-services/operations/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      );
      const claimPayload = (await claimResponse.json()) as {
        operation: { operationId: string; serviceId: string; claimGeneration: number; catalog: { imageDigest: string } };
      };
      expect(claimResponse.status).toBe(200);
      expect(claimPayload.operation.operationId).toBe(operationId);
      expect(claimPayload.operation.serviceId).toBe(serviceId);
      expect(claimPayload.operation.catalog.imageDigest).toBe(`sha256:${"a".repeat(64)}`);

      const startResponse = await skillServiceStartPOST(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operationId}/start`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
          body: JSON.stringify({ claimGeneration: claimPayload.operation.claimGeneration }),
        }),
        { params: Promise.resolve({ operationId }) },
      );
      expect(startResponse.status).toBe(200);

      const renewResponse = await skillServiceRenewLeasePOST(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operationId}/renew-lease`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
          body: JSON.stringify({ claimGeneration: claimPayload.operation.claimGeneration }),
        }),
        { params: Promise.resolve({ operationId }) },
      );
      expect(renewResponse.status).toBe(200);

      const completeResponse = await skillServiceCompletePOST(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operationId}/complete`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
          body: JSON.stringify({
            claimGeneration: claimPayload.operation.claimGeneration,
            endpointRef: "runtime-private://route-renderer",
            healthRevision: "3",
          }),
        }),
        { params: Promise.resolve({ operationId }) },
      );
      const completePayload = (await completeResponse.json()) as { operation: { status: string } };
      expect(completeResponse.status).toBe(200);
      expect(completePayload.operation.status).toBe("succeeded");

      expect(readManagedSkillServiceSync(serviceId, "default")?.status).toBe("ready");
    });

    it("records a failed managed service operation through the daemon fail route", async () => {
      const daemonToken = createDaemonApiTokenSync({ label: "remote-daemon", createdBy: "techwu" });
      const { runtimeId, serviceId, operationId } = seedSkillServiceOperation(daemonToken.id, "build-box-svc-failure");

      const claimResponse = await skillServiceClaimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/skill-services/operations/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      );
      expect(claimResponse.status).toBe(200);
      const claimPayload = (await claimResponse.json()) as { operation: { claimGeneration: number } };

      const failResponse = await skillServiceFailPOST(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operationId}/fail`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
          body: JSON.stringify({
            claimGeneration: claimPayload.operation.claimGeneration,
            errorCode: "skill_service.image_pull_failed",
            errorMessage: "registry timeout",
          }),
        }),
        { params: Promise.resolve({ operationId }) },
      );
      const failPayload = (await failResponse.json()) as { operation: { status: string } };
      expect(failResponse.status).toBe(200);
      expect(failPayload.operation.status).toBe("failed");

      const failed = readManagedSkillServiceOperationSync(operationId, "default");
      expect(failed?.status).toBe("failed");
      expect(failed?.errorCode).toBe("skill_service.image_pull_failed");
      expect(failed?.errorMessage).toBe("registry timeout");
      expect(readManagedSkillServiceSync(serviceId, "default")?.status).toBe("provisioning");
    });

    it("completes a retire operation through the daemon route without an endpoint", async () => {
      const daemonToken = createDaemonApiTokenSync({ label: "remote-daemon", createdBy: "techwu" });
      const { runtimeId, serviceId, operationId } = seedSkillServiceOperation(daemonToken.id, "build-box-svc-retire", "retire");

      const claimResponse = await skillServiceClaimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/skill-services/operations/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      );
      expect(claimResponse.status).toBe(200);
      const claimPayload = (await claimResponse.json()) as { operation: { claimGeneration: number } };

      const completeResponse = await skillServiceCompletePOST(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operationId}/complete`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
          body: JSON.stringify({ claimGeneration: claimPayload.operation.claimGeneration }),
        }),
        { params: Promise.resolve({ operationId }) },
      );
      const completePayload = (await completeResponse.json()) as { operation: { status: string } };
      expect(completeResponse.status).toBe(200);
      expect(completePayload.operation.status).toBe("succeeded");

      expect(readManagedSkillServiceSync(serviceId, "default")?.status).toBe("retired");
    });

    it("delivers decrypted secrets for a claimed provision operation", async () => {
      process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      const daemonToken = createDaemonApiTokenSync({ label: "remote-daemon", createdBy: "techwu" });
      const snapshot = registerDaemonRuntimesSync({
        daemonTokenId: daemonToken.id,
        daemonKey: "build-box-svc-secrets",
        deviceName: "Build Box Secrets",
        runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
      });
      const runtimeId = snapshot.runtimes[0]!.id;
      const catalog = upsertSkillServiceCatalogSync({
        workspaceId: "default",
        slug: "route-secret-renderer",
        templateVersion: "1.0.0",
        deploymentType: "managed_service",
        imageDigest: `sha256:${"a".repeat(64)}`,
        secretFieldsJson: JSON.stringify(["RENDER_LICENSE"]),
      });
      const setResult = setWorkspaceServiceSecretSync({
        workspaceId: "default",
        serviceCatalogId: catalog.id,
        name: "RENDER_LICENSE",
        value: "sk-route-123",
      });
      expect(setResult.ok).toBe(true);

      const managed = createManagedSkillServiceSync({
        workspaceId: "default",
        runtimeId,
        catalogId: catalog.id,
        status: "provisioning",
      });
      const operation = createManagedSkillServiceOperationSync({
        workspaceId: "default",
        runtimeId,
        serviceId: managed.id,
        operation: "provision",
      });

      const claimResponse = await skillServiceClaimPOST(
        new Request(`http://localhost/api/daemon/runtimes/${runtimeId}/skill-services/operations/claim`, {
          method: "POST",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ runtimeId }) },
      );
      expect(claimResponse.status).toBe(200);
      const claimPayload = (await claimResponse.json()) as { operation: { claimGeneration: number } };

      const secretsResponse = await skillServiceSecretsGET(
        new Request(`http://localhost/api/daemon/skill-service-operations/${operation.id}/secrets?claimGeneration=${claimPayload.operation.claimGeneration}`, {
          method: "GET",
          headers: daemonHeaders(daemonToken.token),
        }),
        { params: Promise.resolve({ operationId: operation.id }) },
      );
      expect(secretsResponse.status).toBe(200);
      const payload = (await secretsResponse.json()) as { secrets: Record<string, string> };
      expect(payload.secrets).toEqual({ RENDER_LICENSE: "sk-route-123" });
    });
  });
});
