import {
  DEFAULT_WORKSPACE_ID,
  readAgentRuntimeSync,
  readAgentRouterSessionSync,
  readEmployeeRuntimeBindingSync,
  readStoredEmployeeSync,
} from "@dofe-agent/db";
import { getModelsInternalClient } from "./client.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";
import { recordAuditLogSync } from "@dofe-agent/db";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import type { ModelsInternalRuntimeCredentialModel } from "@dofe/models-sdk";

export interface ResolveEffectiveModelInput {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
  routerSessionId?: string;
}

export interface EffectiveModelResolution {
  modelId: string;
  source:
    | "session_override"
    | "employee_default"
    | "runtime_default"
    | "team_policy_default"
    | "protocol_fallback";
  runtimeCredentialId: string;
  /** True if the chosen model was validated against the active credential's catalog. */
  validated: boolean;
}

interface ResolutionContext {
  workspaceId: string;
  runtime: NonNullable<ReturnType<typeof readAgentRuntimeSync>>;
  employee: ReturnType<typeof readStoredEmployeeSync>;
  session: ReturnType<typeof readAgentRouterSessionSync>;
  availableModels: ModelsInternalRuntimeCredentialModel[];
}

/**
 * Resolve the effective model for a task using the priority hierarchy:
 *   1. session `/model` override
 *   2. AI employee default model
 *   3. Runtime default model
 *   4. workspace team policy default model (read from workspace_state)
 *   5. first protocol-compatible model from the active RuntimeCredential catalog
 *
 * Each candidate is validated against `runtimeCredentials.models`; an invalid
 * candidate falls back to the next level and emits a warning audit event.
 */
export async function resolveEffectiveModelForTaskAsync(
  input: ResolveEffectiveModelInput,
): Promise<EffectiveModelResolution> {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("model_resolution.remote_mode_required");
  }
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("model_resolution.runtime_not_found");
  }
  if (!runtime.managedCredentialId) {
    throw new Error("model_resolution.not_a_managed_runtime");
  }

  const employee = readStoredEmployeeSync(input.employeeName, workspaceId);
  const session = input.routerSessionId
    ? readAgentRouterSessionSync(input.routerSessionId)
    : null;

  const scope = resolveManagedRuntimeScopeSync(workspaceId);
  const client = getModelsInternalClient();
  const response = await client.runtimeCredentials.models({
    params: { id: runtime.managedCredentialId },
    query: { tenantId: scope.tenantId, teamId: scope.teamId },
  });
  const availableModels = response.list;

  const ctx: ResolutionContext = {
    workspaceId,
    runtime,
    employee,
    session,
    availableModels,
  };

  const candidates: Array<{ modelId: string; source: EffectiveModelResolution["source"] }> = [
    session?.modelOverride ? { modelId: session.modelOverride, source: "session_override" } : null,
    employee?.defaultModel ? { modelId: employee.defaultModel, source: "employee_default" } : null,
    runtime.defaultModel ? { modelId: runtime.defaultModel, source: "runtime_default" } : null,
    { modelId: readTeamPolicyDefaultModelSync(workspaceId), source: "team_policy_default" },
    { modelId: firstAvailableModelAlias(availableModels), source: "protocol_fallback" },
  ].filter((item): item is { modelId: string; source: EffectiveModelResolution["source"] } => Boolean(item?.modelId));

  for (const candidate of candidates) {
    if (isModelAvailable(candidate.modelId, availableModels)) {
      return {
        modelId: candidate.modelId,
        source: candidate.source,
        runtimeCredentialId: runtime.managedCredentialId,
        validated: true,
      };
    }
    if (candidate.source === "session_override") {
      throw new Error("model_resolution.session_override_unavailable");
    }
    recordModelFallbackWarning(ctx, candidate.modelId, candidate.source);
  }

  const fallback = firstAvailableModelAlias(availableModels);
  if (!fallback) {
    throw new Error("model_resolution.no_available_model");
  }
  return {
    modelId: fallback,
    source: "protocol_fallback",
    runtimeCredentialId: runtime.managedCredentialId,
    validated: false,
  };
}

function isModelAvailable(
  modelId: string,
  availableModels: ModelsInternalRuntimeCredentialModel[],
): boolean {
  return availableModels.some(
    (model) =>
      model.isAvailable &&
      model.isEnabled !== false &&
      (model.alias === modelId ||
        model.model === modelId ||
        model.id === modelId),
  );
}

function firstAvailableModelAlias(
  availableModels: ModelsInternalRuntimeCredentialModel[],
): string {
  return availableModels.find((model) => model.isAvailable && model.isEnabled !== false)?.alias ?? "";
}

function readTeamPolicyDefaultModelSync(workspaceId: string): string {
  const state = ensureWorkspaceStateSync(workspaceId);
  const policy = (state as unknown as { runtimePolicy?: { defaultModel?: string } }).runtimePolicy;
  return policy?.defaultModel ?? "";
}

function recordModelFallbackWarning(
  ctx: ResolutionContext,
  modelId: string,
  source: EffectiveModelResolution["source"],
): void {
  try {
    recordAuditLogSync({
      workspaceId: ctx.workspaceId,
      title: "Model resolution fallback",
      note: `Chosen model "${modelId}" from ${source} is not available for runtime credential; falling back.`,
      code: "model.resolution_fallback",
      source: "runtime_model",
      data: {
        actorType: "system",
        resourceType: "runtime",
        resourceId: ctx.runtime.id,
        modelId,
        source,
      },
    });
  } catch {
    // Best-effort audit; do not fail model resolution because of logging.
  }
}

export async function resolveEffectiveModelForBoundEmployeeAsync(
  input: Omit<ResolveEffectiveModelInput, "runtimeId">,
): Promise<EffectiveModelResolution> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    throw new Error("model_resolution.no_bound_runtime");
  }
  return resolveEffectiveModelForTaskAsync({
    workspaceId,
    employeeName: input.employeeName,
    runtimeId: binding.runtimeId,
    routerSessionId: input.routerSessionId,
  });
}

/**
 * Verify a requested chat override before it is persisted. Returning the
 * catalog alias keeps stored overrides stable even when a caller supplied a
 * provider-native model or catalog record id.
 */
export async function validateModelOverrideForBoundEmployeeAsync(input: {
  workspaceId?: string;
  employeeName: string;
  modelId: string;
}): Promise<{ modelId: string; runtimeCredentialId: string }> {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("model_resolution.remote_mode_required");
  }

  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const binding = readEmployeeRuntimeBindingSync(input.employeeName, workspaceId);
  if (!binding) {
    throw new Error("model_resolution.no_bound_runtime");
  }
  const runtime = readAgentRuntimeSync(binding.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId || !runtime.managedCredentialId) {
    throw new Error("model_resolution.not_a_managed_runtime");
  }

  const scope = resolveManagedRuntimeScopeSync(workspaceId);
  const response = await getModelsInternalClient().runtimeCredentials.models({
    params: { id: runtime.managedCredentialId },
    query: { tenantId: scope.tenantId, teamId: scope.teamId },
  });
  const requestedModel = input.modelId.trim();
  const model = response.list.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.isEnabled !== false &&
      (candidate.alias === requestedModel || candidate.model === requestedModel || candidate.id === requestedModel),
  );
  if (!model?.alias) {
    throw new Error("model_resolution.model_unavailable");
  }

  return { modelId: model.alias, runtimeCredentialId: runtime.managedCredentialId };
}
