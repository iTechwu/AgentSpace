"use server";

import { readAgentRuntimeSync, updateAgentRuntimeManagedFieldsSync } from "@dofe-agent/db";
import { DAEMON_PROVIDER_PROTOCOLS } from "@dofe-agent/domain";
import {
  cancelRuntimeProvisioningTaskAsync,
  deleteManagedRuntimeAsync,
  ensureManagedRuntimeCapacitySync,
  getManagedRuntimeCredentialStatusAsync,
  getRuntimeProvisioningTaskDetailSync,
  listManagedRuntimeTasksSync,
  preflightManagedRuntimeCreationAsync,
  resolveAgentRuntimeMode,
  resolveManagedRuntimeScopeSync,
  retryRuntimeProvisioningTaskSync,
  rotateManagedRuntimeCredentialAsync,
  stopManagedRuntimeAsync,
} from "@dofe-agent/services";
import {
  getModelsInternalClient,
  isExecutionLanguageModel,
  isModelsInternalConfigured,
} from "@dofe-agent/services";
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
  forceProvisioning?: boolean;
}): Promise<
  | { kind: "reused"; runtimeId: string; runtimeName: string }
  | { kind: "provisioning"; taskId: string }
> {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  const result = ensureManagedRuntimeCapacitySync({
    workspaceId,
    actorUserId,
    provider: input.provider,
    defaultModel: input.defaultModel,
    allowedModels: input.allowedModels,
    idempotencyKey: input.idempotencyKey,
    targetServer: input.targetServer,
    name: input.name,
    allowNewEmployeeSharing: input.allowNewEmployeeSharing,
    forceProvisioning: input.forceProvisioning,
  });
  revalidateWorkspacePath("/runtimes", slug);
  return result.kind === "reused"
    ? result
    : { kind: "provisioning", taskId: result.task.id };
}

export async function preflightManagedRuntimeAction(input: {
  provider: DaemonProvider;
  defaultModel?: string;
  forceProvisioning?: boolean;
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
    forceProvisioning: input.forceProvisioning,
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

export async function updateManagedRuntimeDefaultModelAction(input: {
  runtimeId: string;
  defaultModel?: string;
}): Promise<void> {
  assertRemoteManagedRuntimeMode();
  const { workspaceId, slug } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }

  const requestedModel = input.defaultModel?.trim() ?? "";
  let defaultModel: string | undefined;
  if (requestedModel) {
    if (!isModelsInternalConfigured()) {
      throw new Error("managed_runtime.models_not_configured");
    }
    const { tenantId, teamId } = resolveManagedRuntimeScopeSync(workspaceId);
    const response = await getModelsInternalClient().runtimeCredentials.models({
      params: { id: runtime.managedCredentialId },
      query: { tenantId, teamId },
    });
    const selected = response.list.find(
      (model) =>
        isExecutionLanguageModel(model) &&
        model.isAvailable &&
        model.isEnabled !== false &&
        (model.alias === requestedModel || model.model === requestedModel || model.id === requestedModel),
    );
    if (!selected?.alias) {
      throw new Error("managed_runtime.model_unavailable");
    }
    defaultModel = selected.alias;
  }

  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId,
    // The database helper treats undefined as "leave unchanged"; an empty
    // string intentionally clears the runtime default and restores fallback.
    defaultModel: defaultModel ?? "",
  });
  revalidateWorkspacePath(`/runtimes/runtime/${runtime.id}`, slug);
  revalidateWorkspacePath("/runtimes", slug);
}

export interface RuntimeModelCatalogItem {
  alias: string;
  displayName?: string | null;
  model?: string;
  modelType: "llm";
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
    .filter(isExecutionLanguageModel)
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
        modelType: "llm" as const,
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
  const list = response.list.filter(isExecutionLanguageModel).map((model) => {
    const catalogModel = model as typeof model & {
      supportedProtocols?: string[];
      contextLength?: number;
      supportsVision?: boolean;
      supportsFunctionCalling?: boolean;
      inputPrice?: number | null;
      outputPrice?: number | null;
    };
    const supportedProtocols = catalogModel.supportedProtocols ?? [];
    return {
      id: model.id ?? model.alias,
      alias: model.alias,
      model: model.model,
      displayName: model.displayName,
      modelType: "llm" as const,
      protocol: supportedProtocols.find((protocol) => (runtime.protocols ?? []).includes(protocol)) ?? supportedProtocols[0],
      contextLength: catalogModel.contextLength,
      supportsVision: catalogModel.supportsVision,
      supportsFunctionCalling: catalogModel.supportsFunctionCalling,
      inputPrice: catalogModel.inputPrice,
      outputPrice: catalogModel.outputPrice,
      isAvailable: model.isAvailable,
      isEnabled: model.isEnabled,
    };
  });
  return {
    list,
    total: list.length,
    configured: true as const,
  };
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
