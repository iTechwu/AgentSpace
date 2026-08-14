// 模型选择与凭证轮换：allowlist 校验、默认模型设置、凭证 rotate。
import {
  markRuntimeCredentialReconciliationTargetDrainingSync,
  readAgentRuntimeSync,
  recordAuditLogSync,
  updateAgentRuntimeManagedFieldsSync,
  upsertActiveRuntimeCredentialReconciliationTargetSync,
} from "@dofe-agent/db";
import type {
  AgentRuntimeRecord,
} from "@dofe-agent/db";
import {
  resolveProviderProtocols,
} from "@dofe-agent/domain";
import {
  notifyWorkspaceAdminsSync,
} from "../notifications/notifications.ts";
import {
  getRuntimeCredentialVault,
} from "./credential-vault.ts";
import type {
  ModelsInternalRotateRuntimeCredentialRequest,
} from "@dofe/models-sdk";
import {
  assertCanManageManagedRuntimes,
  assertRemoteRuntimeMode,
  resolveManagedRuntimeAllowedModels,
  resolveManagedRuntimeScopeSync,
} from "./runtime-provisioning-capacity.ts";
import type {
  ManagedRuntimeActor,
} from "./runtime-provisioning-capacity.ts";
import {
  assertManagedRuntimeModelSelectionAsync,
  resolveCredentialReconciliationRetireAfter,
  safeRevokeCredential,
} from "./runtime-provisioning-pipeline.ts";
import type {
  ModelsCreateResult,
} from "./runtime-provisioning-pipeline.ts";
import { clientProvider } from "./runtime-provisioning-models-client.ts";

export interface RotateManagedRuntimeCredentialInput extends ManagedRuntimeActor {
  runtimeId: string;
  reason?: ModelsInternalRotateRuntimeCredentialRequest["reason"];
  operationId?: string;
}

export async function rotateManagedRuntimeCredentialAsync(
  input: RotateManagedRuntimeCredentialInput,
): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "needs_attention") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
  if (!runtime.managedCredentialId) {
    throw new Error("managed_runtime.no_credential");
  }
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = clientProvider();
  const credentialId = runtime.managedCredentialId;
  const reason = input.reason ?? "manual";
  const operationId = input.operationId?.trim() || crypto.randomUUID();
  let reissuedForCurrentScope = false;
  let result: ModelsCreateResult;
  try {
    result = await client.runtimeCredentials.rotate({
      params: { id: credentialId },
      body: {
        tenantId: scope.tenantId,
        teamId: scope.teamId,
        idempotencyKey: `rotate:${credentialId}:${reason}:${operationId}`,
        reason,
        audit: { actorId: input.actorUserId },
      },
    });
  } catch (error) {
    // Workspaces can be moved between SSO teams after a runtime has already
    // been provisioned. The old credential is intentionally invisible in the
    // new scope, so issue a replacement instead of leaving the runtime unable
    // to load its model catalog forever.
    if (!isModelsNotFoundError(error)) {
      throw error;
    }
    reissuedForCurrentScope = true;
    result = await client.runtimeCredentials.create({
      body: {
        tenantId: scope.tenantId,
        teamId: scope.teamId,
        runtimeId: runtime.id,
        runtimeType: runtime.provider,
        protocols: runtime.protocols?.length ? runtime.protocols : resolveProviderProtocols(runtime.provider),
        allowedModels: resolveManagedRuntimeAllowedModels(
          runtime.provider,
          runtime.defaultModel ? [runtime.defaultModel] : [],
        ),
        defaultModel: runtime.defaultModel,
        idempotencyKey: `reissue:${runtime.id}:${operationId}`,
        audit: { actorId: input.actorUserId, replacedCredentialId: credentialId },
      },
    });
  }
  if (!result.secretIssued || !result.secret?.apiKey) {
    const today = new Date().toISOString().slice(0, 10);
    notifyWorkspaceAdminsSync({
      workspaceId: input.workspaceId,
      title: "Runtime credential rotation failed",
      body: `Credential rotation for ${runtime.provider} runtime "${runtime.name ?? runtime.id}" failed: the model service did not issue a new secret.`,
      type: "runtime.credential_rotation_failed",
      severity: "critical",
      resourceType: "workspace",
      resourceId: runtime.id,
      dedupeKey: `runtime.credential_rotation_failed:${input.workspaceId}:${runtime.id}:${today}`,
      metadata: {
        runtimeId: runtime.id,
        runtimeCredentialId: credentialId,
        runtimeType: runtime.provider,
      },
    });
    throw new Error("managed_runtime.rotate_no_secret");
  }
  const vault = getRuntimeCredentialVault();
  const oldSecretRef = runtime.credentialSecretRef;
  const credentialScope = { tenantId: scope.tenantId, teamId: scope.teamId, runtimeId: runtime.id };
  const newSecret = vault.store(result.credential.id, result.secret.apiKey, credentialScope);
  markRuntimeCredentialReconciliationTargetDrainingSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: credentialId,
    retireAfter: resolveCredentialReconciliationRetireAfter(),
  });
  upsertActiveRuntimeCredentialReconciliationTargetSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: result.credential.id,
  });
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "managed",
    status: "online",
    managedCredentialId: result.credential.id,
    credentialSecretRef: newSecret.secretRef,
  });
  if (oldSecretRef && oldSecretRef !== newSecret.secretRef) {
    vault.forget(oldSecretRef, credentialScope);
  }
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: reissuedForCurrentScope ? "Runtime credential reissued" : "Runtime credential rotated",
    note: `${reissuedForCurrentScope ? "Credential reissued" : "Credential rotated"} from ${credentialId} to ${result.credential.id}`,
    code: reissuedForCurrentScope ? "runtime_credential.reissued" : "runtime_credential.rotated",
    source: "runtime_credential",
    data: {
      runtimeId: runtime.id,
      previousCredentialId: credentialId,
      newCredentialId: result.credential.id,
      newKeyFingerprint: result.credential.keyFingerprint ?? "",
      reason,
      operationId,
      reissuedForCurrentScope,
      actorId: input.actorUserId,
    },
  });
  const updated = readAgentRuntimeSync(runtime.id);
  return updated ?? runtime;
}

export interface SetManagedRuntimeDefaultModelInput extends ManagedRuntimeActor {
  runtimeId: string;
  defaultModel?: string;
  operationId?: string;
}

export interface EnsureManagedRuntimeModelAllowedInput extends ManagedRuntimeActor {
  runtimeId: string;
  modelId: string;
  operationId?: string;
}

/**
 * Employee defaults share the bound Runtime credential. Responses runtimes use
 * the full protocol-compatible catalog; other runtimes extend an explicit
 * allowlist without changing the Runtime default.
 */

export async function ensureManagedRuntimeModelAllowedAsync(
  input: EnsureManagedRuntimeModelAllowedInput,
): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "needs_attention") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }

  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new Error("managed_runtime.model_required");
  }

  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = clientProvider();
  const runtimeProtocols = runtime.protocols?.length
    ? runtime.protocols
    : resolveProviderProtocols(runtime.provider);
  await assertManagedRuntimeModelSelectionAsync({
    client,
    tenantId: scope.tenantId,
    protocols: runtimeProtocols,
    requestedModel: modelId,
  });
  const previousCredentialId = runtime.managedCredentialId;
  const credential = await client.runtimeCredentials.get({
    params: { id: previousCredentialId },
    query: { tenantId: scope.tenantId, teamId: scope.teamId },
  });
  const allowedModels = credential.allowedModels
    .map((value) => value.trim())
    .filter(Boolean);
  const usesProtocolCatalog = resolveProviderProtocols(runtime.provider).includes("openai_response");
  if (allowedModels.length === 0 || (!usesProtocolCatalog && allowedModels.includes(modelId))) {
    return runtime;
  }

  const operationId = input.operationId?.trim() || crypto.randomUUID();
  const nextAllowedModels = resolveManagedRuntimeAllowedModels(
    runtime.provider,
    [...allowedModels, modelId],
  );
  await safeRevokeCredential({
    credentialId: previousCredentialId,
    tenantId: scope.tenantId,
    teamId: scope.teamId,
    reason: "manual",
    idempotencyKey: `revoke:${previousCredentialId}:model-allowlist:${operationId}`,
    audit: { actorId: input.actorUserId },
  });
  const result = await client.runtimeCredentials.create({
    body: {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      runtimeId: runtime.id,
      runtimeType: runtime.provider,
      protocols: credential.protocols.length > 0
        ? credential.protocols
        : runtimeProtocols,
      allowedModels: nextAllowedModels,
      defaultModel: runtime.defaultModel || undefined,
      idempotencyKey: `model-allowlist:${runtime.id}:${modelId}:${operationId}`,
      audit: { actorId: input.actorUserId },
    },
  });
  if (!result.secretIssued || !result.secret?.apiKey) {
    throw new Error("managed_runtime.model_allowlist_change_no_secret");
  }

  const vault = getRuntimeCredentialVault();
  const previousSecretRef = runtime.credentialSecretRef;
  const credentialScope = { tenantId: scope.tenantId, teamId: scope.teamId, runtimeId: runtime.id };
  const secret = vault.store(result.credential.id, result.secret.apiKey, credentialScope);
  markRuntimeCredentialReconciliationTargetDrainingSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: previousCredentialId,
    retireAfter: resolveCredentialReconciliationRetireAfter(),
  });
  upsertActiveRuntimeCredentialReconciliationTargetSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: result.credential.id,
  });
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "managed",
    status: "online",
    managedCredentialId: result.credential.id,
    credentialSecretRef: secret.secretRef,
  });
  if (previousSecretRef && previousSecretRef !== secret.secretRef) {
    vault.forget(previousSecretRef, credentialScope);
  }
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Runtime model allowlist expanded",
    note: `Runtime ${runtime.id} now allows employee model ${modelId}.`,
    code: "runtime.model_allowlist.expanded",
    source: "runtime_credential",
    data: {
      runtimeId: runtime.id,
      previousCredentialId,
      newCredentialId: result.credential.id,
      modelId,
      operationId,
      actorId: input.actorUserId,
    },
  });
  return readAgentRuntimeSync(runtime.id) ?? runtime;
}

/**
 * A runtime credential allowlist is enforced by the gateway. Selecting a new
 * default therefore needs a new credential, rather than only changing the
 * AgentSpace row and leaving the selected model impossible to call.
 */

export async function setManagedRuntimeDefaultModelAsync(
  input: SetManagedRuntimeDefaultModelInput,
): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId || !runtime.managedCredentialId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "needs_attention") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }

  const defaultModel = input.defaultModel?.trim() || undefined;
  if (defaultModel && runtime.defaultModel === defaultModel) {
    return runtime;
  }

  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const protocols = runtime.protocols?.length ? runtime.protocols : resolveProviderProtocols(runtime.provider);
  const client = clientProvider();
  const previousCredentialId = runtime.managedCredentialId;
  const operationId = input.operationId?.trim() || crypto.randomUUID();
  // The Models API enforces one active credential per runtime. Its rotate
  // endpoint cannot change an allowlist, so retire the prior credential before
  // issuing the replacement that carries the selected model.
  await safeRevokeCredential({
    credentialId: previousCredentialId,
    tenantId: scope.tenantId,
    teamId: scope.teamId,
    reason: "manual",
    idempotencyKey: `revoke:${previousCredentialId}:model-change:${operationId}`,
    audit: { actorId: input.actorUserId },
  });
  const result = await client.runtimeCredentials.create({
    body: {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      runtimeId: runtime.id,
      runtimeType: runtime.provider,
      protocols,
      allowedModels: resolveManagedRuntimeAllowedModels(
        runtime.provider,
        defaultModel ? [defaultModel] : [],
      ),
      defaultModel,
      idempotencyKey: `model-change:${runtime.id}:${defaultModel ?? "system"}:${operationId}`,
      audit: { actorId: input.actorUserId },
    },
  });
  if (!result.secretIssued || !result.secret?.apiKey) {
    throw new Error("managed_runtime.model_change_no_secret");
  }

  const vault = getRuntimeCredentialVault();
  const previousSecretRef = runtime.credentialSecretRef;
  const credentialScope = { tenantId: scope.tenantId, teamId: scope.teamId, runtimeId: runtime.id };
  const secret = vault.store(result.credential.id, result.secret.apiKey, credentialScope);
  markRuntimeCredentialReconciliationTargetDrainingSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: previousCredentialId,
    retireAfter: resolveCredentialReconciliationRetireAfter(),
  });
  upsertActiveRuntimeCredentialReconciliationTargetSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    runtimeCredentialId: result.credential.id,
  });
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "managed",
    status: "online",
    managedCredentialId: result.credential.id,
    credentialSecretRef: secret.secretRef,
    defaultModel: defaultModel ?? "",
  });
  if (previousSecretRef && previousSecretRef !== secret.secretRef) {
    vault.forget(previousSecretRef, credentialScope);
  }
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Runtime default model changed",
    note: `Runtime ${runtime.id} default model changed from ${runtime.defaultModel ?? "inherit"} to ${defaultModel ?? "system default"}.`,
    code: "runtime.default_model.changed",
    source: "runtime_credential",
    data: {
      runtimeId: runtime.id,
      previousCredentialId,
      newCredentialId: result.credential.id,
      previousModel: runtime.defaultModel ?? "",
      defaultModel: defaultModel ?? "",
      operationId,
      actorId: input.actorUserId,
    },
  });
  return readAgentRuntimeSync(runtime.id) ?? runtime;
}

function isModelsNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === 404,
  );
}
