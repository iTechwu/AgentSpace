"use server";

import { readAgentRuntimeSync, updateAgentRuntimeManagedFieldsSync } from "@dofe-agent/db";
import { DAEMON_PROVIDER_PROTOCOLS } from "@dofe-agent/domain";
import {
  cancelRuntimeProvisioningTaskAsync,
  deleteManagedRuntimeAsync,
  getManagedRuntimeCredentialStatusAsync,
  getRuntimeProvisioningTaskDetailSync,
  listManagedRuntimeTasksSync,
  preflightManagedRuntimeCreationAsync,
  requestManagedRuntimeProvisioningSync,
  resolveAgentRuntimeMode,
  resolveManagedRuntimeScopeSync,
  retryRuntimeProvisioningTaskSync,
  rotateManagedRuntimeCredentialAsync,
  stopManagedRuntimeAsync,
} from "@dofe-agent/services";
import { getModelsInternalClient, isModelsInternalConfigured } from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";
import type { DaemonProvider } from "@dofe-agent/domain";

function requireAdminActor() {
  return requireCurrentWorkspaceContext().then((ctx) => {
    assertWorkspaceRoleForContext(ctx, "admin");
    return {
      workspaceId: ctx.currentWorkspace.id,
      actorUserId: ctx.currentUser.id,
      slug: ctx.currentWorkspace.slug,
    };
  });
}

function assertRemoteManagedRuntimeMode(): void {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("managed_runtime.remote_mode_required");
  }
}

export async function createManagedRuntimeAction(input: {
  provider: DaemonProvider;
  defaultModel?: string;
  allowedModels?: string[];
  idempotencyKey: string;
  targetServer?: string;
  name?: string;
  allowNewEmployeeSharing?: boolean;
}): Promise<{ taskId: string }> {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  const task = requestManagedRuntimeProvisioningSync({
    workspaceId,
    actorUserId,
    provider: input.provider,
    defaultModel: input.defaultModel,
    allowedModels: input.allowedModels,
    idempotencyKey: input.idempotencyKey,
    targetServer: input.targetServer,
    name: input.name,
    allowNewEmployeeSharing: input.allowNewEmployeeSharing,
  });
  revalidateWorkspacePath("/runtimes", slug);
  return { taskId: task.id };
}

export async function preflightManagedRuntimeAction(input: {
  provider: DaemonProvider;
  defaultModel?: string;
}) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId } = await requireAdminActor();
  if (!isModelsInternalConfigured()) {
    return {
      allowed: false,
      code: "managed_runtime.models_not_configured",
      message: "The models service is not configured for this deployment.",
    };
  }
  return preflightManagedRuntimeCreationAsync({
    workspaceId,
    actorUserId,
    provider: input.provider,
    defaultModel: input.defaultModel,
  });
}

export async function getProvisioningTaskAction(taskId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId } = await requireAdminActor();
  return getRuntimeProvisioningTaskDetailSync({ workspaceId, actorUserId, taskId });
}

export async function listManagedRuntimeTasksAction() {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId } = await requireAdminActor();
  return listManagedRuntimeTasksSync({ workspaceId, actorUserId });
}

export async function retryProvisioningAction(taskId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  const task = retryRuntimeProvisioningTaskSync({ workspaceId, actorUserId, taskId });
  revalidateWorkspacePath(`/runtimes/${task.id}`, slug);
  return { taskId: task.id };
}

export async function cancelProvisioningAction(taskId: string, reason?: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  await cancelRuntimeProvisioningTaskAsync({ workspaceId, actorUserId, taskId, reason });
  revalidateWorkspacePath("/runtimes", slug);
}

export async function stopManagedRuntimeAction(runtimeId: string, reason?: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  await stopManagedRuntimeAsync({ workspaceId, actorUserId, runtimeId, reason });
  revalidateWorkspacePath("/runtimes", slug);
}

export async function deleteManagedRuntimeAction(runtimeId: string, reason?: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  await deleteManagedRuntimeAsync({ workspaceId, actorUserId, runtimeId, reason });
  revalidateWorkspacePath("/runtimes", slug);
}

export async function rotateManagedRuntimeCredentialAction(
  runtimeId: string,
  reason?: "manual" | "expired" | "compromised" | "gateway-rejected",
) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  await rotateManagedRuntimeCredentialAsync({
    workspaceId,
    actorUserId,
    runtimeId,
    reason: reason ?? "manual",
  });
  revalidateWorkspacePath("/runtimes", slug);
}

export async function getManagedRuntimeCredentialStatusAction(runtimeId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId } = await requireAdminActor();
  return getManagedRuntimeCredentialStatusAsync({ workspaceId, actorUserId, runtimeId });
}

export async function updateManagedRuntimeSharingAction(input: {
  runtimeId: string;
  allowNewEmployeeSharing: boolean;
}): Promise<void> {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, slug } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: input.runtimeId,
    workspaceId,
    allowNewEmployeeSharing: input.allowNewEmployeeSharing,
  });
  revalidateWorkspacePath(`/runtimes/runtime/${input.runtimeId}`, slug);
  revalidateWorkspacePath("/runtimes", slug);
}

export interface RuntimeModelCatalogItem {
  alias: string;
  displayName?: string | null;
  model?: string;
  protocol: string;
  contextLength?: number;
  supportsVision?: boolean;
  supportsFunctionCalling?: boolean;
  inputPrice?: number | null;
  outputPrice?: number | null;
  isAvailable: boolean;
  unavailableReason?: string;
}

export async function listProtocolFilteredRuntimeModelsAction(provider: DaemonProvider): Promise<{
  list: RuntimeModelCatalogItem[];
  configured: boolean;
}> {
  assertRemoteManagedRuntimeMode();
  const { workspaceId } = await requireAdminActor();
  if (!isModelsInternalConfigured()) {
    return { list: [], configured: false };
  }
  const protocols = DAEMON_PROVIDER_PROTOCOLS[provider] ?? [];
  if (protocols.length === 0) {
    return { list: [], configured: true };
  }
  const { tenantId } = resolveManagedRuntimeScopeSync(workspaceId);
  const client = getModelsInternalClient();
  const response = await client.models.list({ query: { tenantId } });
  const list = response.list
    .map((model) => {
      const supported = (model as { supportedProtocols?: string[] }).supportedProtocols ?? [];
      const protocol = protocols.find((p) => supported.includes(p));
      const isAvailable = Boolean(
        protocol &&
          (model as { isEnabled?: boolean }).isEnabled !== false &&
          (model as { isDeprecated?: boolean }).isDeprecated !== true,
      );
      return {
        alias: String((model as { alias?: string }).alias ?? (model as { id?: string }).id ?? ""),
        displayName: (model as { displayName?: string | null }).displayName,
        model: (model as { model?: string }).model,
        protocol: protocol ?? supported[0] ?? "",
        contextLength: (model as { contextLength?: number }).contextLength,
        supportsVision: (model as { supportsVision?: boolean }).supportsVision,
        supportsFunctionCalling: (model as { supportsFunctionCalling?: boolean }).supportsFunctionCalling,
        inputPrice: (model as { inputPrice?: number | null }).inputPrice,
        outputPrice: (model as { outputPrice?: number | null }).outputPrice,
        isAvailable,
        unavailableReason: protocol
          ? isAvailable
            ? undefined
            : "Model is disabled or deprecated"
          : `Runtime protocol (${protocols.join(", ")}) not supported`,
      };
    })
    .filter((item) => item.alias);
  return { list, configured: true };
}

/**
 * Models available to an existing managed runtime (filtered by its credential's
 * protocols + allowlist on models.dofe.ai). Used on the runtime detail page,
 * not the create wizard (no credential exists yet pre-provisioning).
 */
export async function getManagedRuntimeModelsAction(runtimeId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (!isModelsInternalConfigured()) {
    return { list: [], total: 0, configured: false as const };
  }
  const { tenantId, teamId } = resolveManagedRuntimeScopeSync(workspaceId);
  const client = getModelsInternalClient();
  const response = await client.runtimeCredentials.models({
    params: { id: runtime.managedCredentialId },
    query: { tenantId, teamId },
  });
  return { list: response.list, total: response.total, configured: true as const };
}

/**
 * Runtime diagnostics intentionally expose no storage locator or secret data.
 */
export async function getManagedRuntimeDiagnosticAction(runtimeId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  return {
    provisioningState: runtime.provisioningState ?? null,
    managedCredentialId: runtime.managedCredentialId ?? null,
    credentialConfigured: Boolean(runtime.credentialSecretRef),
    protocols: runtime.protocols ?? [],
    defaultModel: runtime.defaultModel ?? null,
  };
}
