import {
  DEFAULT_WORKSPACE_ID,
  readAgentRuntimeSync,
  readAgentRouterSessionSync,
  readEmployeeRuntimeBindingSync,
  readStoredEmployeeSync,
} from "@dofe-agent/db";
import { getModelsInternalClient } from "./client.ts";
import { isExecutionLanguageModel } from "./execution-models.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";
import { recordAuditLogSync } from "@dofe-agent/db";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { listEmployeeSkillIdsSync } from "../employees/employees.ts";
import { readAgentSkillRequirementConfigurationSync } from "../skills/agent-skill-requirements.ts";
import type { ModelsInternalRuntimeCredentialModel } from "@dofe/models-sdk";
import { resolveProviderProtocols, isDaemonProvider } from "@dofe-agent/domain";

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
    | "skill_requirement"
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
 * Returns the model id declared by this employee's installed Skills, but ONLY
 * when every model-requiring Skill agrees on the same id. Conflicting or absent
 * declarations yield `undefined` so model resolution falls back to lower-priority
 * sources instead of guessing. Each candidate is still availability-checked by
 * the caller, so an unavailable skill-declared model safely falls through.
 */
function readSingleSkillRequiredModelIdSync(workspaceId: string, employeeName: string): string | undefined {
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  const modelIds = new Set<string>();
  for (const skillId of skillIds) {
    const { configuration } = readAgentSkillRequirementConfigurationSync({ workspaceId, employeeName, skillId });
    const modelId = configuration?.modelId?.trim();
    if (modelId) {
      modelIds.add(modelId);
    }
  }
  if (modelIds.size === 1) {
    return [...modelIds][0];
  }
  return undefined;
}

/**
 * Resolve the effective model for a task using the priority hierarchy:
 *   1. session `/model` override
 *   2. AI employee default model
 *   3. Skill-declared model (only when every model-requiring Skill on this employee agrees on the same id)
 *   4. Runtime default model
 *   5. workspace team policy default model (read from workspace_state)
 *   6. first protocol-compatible model from the active RuntimeCredential catalog
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
  let response: Awaited<ReturnType<typeof client.runtimeCredentials.models>>;
  try {
    response = await client.runtimeCredentials.models({
      params: { id: runtime.managedCredentialId },
      query: { tenantId: scope.tenantId, teamId: scope.teamId },
    });
  } catch (error) {
    // The runtime default is written alongside the credential allowlist during
    // provisioning. It remains a safe fallback when the control-plane catalog
    // is temporarily unavailable.
    if (runtime.defaultModel) {
      return {
        modelId: runtime.defaultModel,
        source: "runtime_default",
        runtimeCredentialId: runtime.managedCredentialId,
        validated: false,
      };
    }
    // When the control-plane catalog is unavailable AND the runtime has no
    // provisioned default, fall back to the employee-configured model so the
    // task can still execute. The credential will be validated on the next
    // successful catalog fetch. If the employee has no default either, the
    // error propagates — there is nothing left to try.
    if (employee?.defaultModel) {
      recordModelCatalogFallbackWarning({
        workspaceId,
        runtimeId: runtime.id,
        managedCredentialId: runtime.managedCredentialId,
        fallbackModelId: employee.defaultModel,
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        modelId: employee.defaultModel,
        source: "employee_default",
        runtimeCredentialId: runtime.managedCredentialId,
        validated: false,
      };
    }
    throw error;
  }
  // 按运行时 Provider 所需协议过滤模型目录。
  // 例如 Codex 使用 openai_response 协议（/v1/responses），
  // 只支持 chat/completions 的模型（如 deepseek-v4-flash）必须被排除，
  // 否则 Codex 调用时网关会返回 "No available provider"。
  const requiredProtocols = runtime.protocols?.length
    ? runtime.protocols
    : (isDaemonProvider(runtime.provider) ? resolveProviderProtocols(runtime.provider) : []);
  const availableModels = response.list.filter(
    (model) =>
      isExecutionLanguageModel(model) &&
      (requiredProtocols.length === 0 ||
        (model.supportedProtocols ?? []).some((protocol) => requiredProtocols.includes(protocol))),
  );

  const ctx: ResolutionContext = {
    workspaceId,
    runtime,
    employee,
    session,
    availableModels,
  };

  const skillRequiredModelId = readSingleSkillRequiredModelIdSync(workspaceId, input.employeeName);

  const candidates: Array<{ modelId: string; source: EffectiveModelResolution["source"] }> = [
    session?.modelOverride ? { modelId: session.modelOverride, source: "session_override" } : null,
    employee?.defaultModel ? { modelId: employee.defaultModel, source: "employee_default" } : null,
    skillRequiredModelId ? { modelId: skillRequiredModelId, source: "skill_requirement" } : null,
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
    throw new Error(
      `model_resolution.no_available_model: no protocol-compatible models found ` +
      `for provider "${runtime.provider}" (required protocols: ${requiredProtocols.join(", ") || "none"}). ` +
      `Ensure the RuntimeCredential "${runtime.managedCredentialId}" has at least one model ` +
      `supporting these protocols.`,
    );
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

function recordModelCatalogFallbackWarning(input: {
  workspaceId: string;
  runtimeId: string;
  managedCredentialId: string;
  fallbackModelId: string;
  reason: string;
}): void {
  try {
    recordAuditLogSync({
      workspaceId: input.workspaceId,
      title: "Model catalog unavailable — fallback to employee default",
      note: `Models catalog for credential "${input.managedCredentialId}" (runtime ${input.runtimeId}) is unavailable. Falling back to employee default model "${input.fallbackModelId}". Reason: ${input.reason}`,
      code: "model.catalog_fallback",
      source: "runtime_model",
      data: {
        actorType: "system",
        resourceType: "runtime",
        resourceId: input.runtimeId,
        credentialId: input.managedCredentialId,
        fallbackModelId: input.fallbackModelId,
      },
    });
  } catch {
    // Best-effort audit; do not fail model resolution because of logging.
  }
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
      isExecutionLanguageModel(candidate) &&
      candidate.isAvailable &&
      candidate.isEnabled !== false &&
      (candidate.alias === requestedModel || candidate.model === requestedModel || candidate.id === requestedModel),
  );
  if (!model?.alias) {
    throw new Error("model_resolution.model_unavailable");
  }

  return { modelId: model.alias, runtimeCredentialId: runtime.managedCredentialId };
}
