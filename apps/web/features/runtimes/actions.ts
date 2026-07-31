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
  setManagedRuntimeDefaultModelAsync,
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
  const { workspaceId, actorUserId, slug } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }

  const requestedModel = input.defaultModel?.trim() ?? "";
  await setManagedRuntimeDefaultModelAsync({
    workspaceId,
    actorUserId,
    runtimeId: runtime.id,
    defaultModel: requestedModel || undefined,
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
  priceCurrency?: string | null;
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
      const effectivePricing = resolveEffectiveModelPricing(model);
      const supported = (model as { supportedProtocols?: string[] }).supportedProtocols ?? [];
      const protocol = protocols.find((p) => supported.includes(p));
      const codexReady = (model as { codexReady?: boolean }).codexReady === true;
      const isAvailable = Boolean(
        protocol &&
          (protocol !== "openai_response" || codexReady) &&
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
        inputPrice: effectivePricing.inputPrice,
        outputPrice: effectivePricing.outputPrice,
        priceCurrency: effectivePricing.currency,
        isAvailable,
        unavailableReason: protocol
          ? isAvailable
            ? undefined
            : protocol === "openai_response" && !codexReady
              ? "Codex Responses verification required"
              : "Model is disabled or deprecated"
          : `Runtime protocol (${protocols.join(", ")}) not supported`,
      };
    })
    .filter((item) => item.alias);
  return { list, configured: true };
}

/**
 * Models that can become an existing runtime's default. The current credential
 * may have a narrower allowlist, but presenting that list would make changing
 * the default impossible. Saving a selection reissues the credential with the
 * selected model as its gateway allowlist.
 */
export async function getManagedRuntimeModelsAction(runtimeId: string) {
  assertRemoteManagedRuntimeMode();
  const { workspaceId } = await requireAdminActor();
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (!isModelsInternalConfigured()) {
    return { list: [], total: 0, configured: false as const, catalogState: "not_configured" as const };
  }
  let response;
  try {
    const { tenantId } = resolveManagedRuntimeScopeSync(workspaceId);
    response = await getModelsInternalClient().models.list({ query: { tenantId } });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    return {
      list: [], total: 0, configured: false as const,
      catalogState: status === 404 ? "credential_missing" as const : "unavailable" as const,
    };
  }
  const list = response.list.filter(isExecutionLanguageModel).map((model) => {
    const catalogModel = model as typeof model & {
      supportedProtocols?: string[];
      contextLength?: number;
      supportsVision?: boolean;
      supportsFunctionCalling?: boolean;
      inputPrice?: number | null;
      outputPrice?: number | null;
      inputPriceCurrency?: string | null;
      outputPriceCurrency?: string | null;
      pricing?: unknown;
      isAvailable?: boolean;
      codexReady?: boolean;
    };
    const effectivePricing = resolveEffectiveModelPricing(catalogModel);
    const supportedProtocols = catalogModel.supportedProtocols ?? [];
    const runtimeProtocols = runtime.protocols ?? [];
    const matchedProtocol = supportedProtocols.find((protocol) => runtimeProtocols.includes(protocol));
    // Collapse the credential, policy, deprecation, and protocol signals into a
    // single availability flag. The picker shows every catalog entry (greyed
    // out with a reason) instead of silently dropping unavailable ones — which
    // left the dropdown empty when no model was currently usable.
    const credentialAvailable = catalogModel.isAvailable;
    const policyEnabled = model.isEnabled !== false;
    const deprecated = model.isDeprecated === true;
    const codexReady = catalogModel.codexReady === true;
    const isAvailable = Boolean(
      credentialAvailable &&
        policyEnabled &&
        !deprecated &&
        matchedProtocol &&
        (matchedProtocol !== "openai_response" || codexReady),
    );
    const unavailableReason = isAvailable
      ? undefined
      : !matchedProtocol
        ? `Runtime protocol (${runtimeProtocols.join(", ")}) not supported`
        : matchedProtocol === "openai_response" && !codexReady
          ? "Codex Responses verification required"
        : !credentialAvailable
          ? "Credential unavailable"
          : !policyEnabled
            ? "Disabled by team policy"
            : "Model is deprecated";
    return {
      id: model.id ?? model.alias,
      alias: model.alias,
      model: model.model,
      displayName: model.displayName,
      modelType: "llm" as const,
      protocol: matchedProtocol ?? supportedProtocols[0],
      contextLength: catalogModel.contextLength,
      supportsVision: catalogModel.supportsVision,
      supportsFunctionCalling: catalogModel.supportsFunctionCalling,
      inputPrice: effectivePricing.inputPrice,
      outputPrice: effectivePricing.outputPrice,
      priceCurrency: effectivePricing.currency,
      isAvailable,
      isEnabled: model.isEnabled,
      unavailableReason,
    };
  });
  return {
    list,
    total: list.length,
    configured: true as const,
    catalogState: "ready" as const,
  };
}

function resolveEffectiveModelPricing(model: {
  inputPrice?: number | null;
  outputPrice?: number | null;
  inputPriceCurrency?: string | null;
  outputPriceCurrency?: string | null;
  pricing?: unknown;
}): { inputPrice?: number | null; outputPrice?: number | null; currency?: string | null } {
  const pricing = typeof model.pricing === "object" && model.pricing !== null
    ? model.pricing as Record<string, unknown>
    : undefined;
  return {
    inputPrice: typeof pricing?.actualInputPrice === "number" ? pricing.actualInputPrice : model.inputPrice,
    outputPrice: typeof pricing?.actualOutputPrice === "number" ? pricing.actualOutputPrice : model.outputPrice,
    currency: typeof pricing?.currency === "string"
      ? pricing.currency
      : model.inputPriceCurrency ?? model.outputPriceCurrency,
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
