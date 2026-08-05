import { timingSafeEqual } from "node:crypto";
import {
  createOpenMontageJobLinkSync,
  listOpenMontageDelegationDrainPendingJobIdsSync,
  readOpenMontageJobLinkSync,
  readOpenMontageJobProjectionSync,
  readOpenMontageModelDelegationSync,
  updateOpenMontageModelDelegationStatusSync,
  type CreateOpenMontageJobLinkInput,
  type OpenMontageJobLinkRecord,
  type OpenMontageModelDelegationRecord,
} from "@dofe-agent/db";
import type {
  OpenMontageJobAttribution,
  OpenMontageJobProjection,
  OpenMontageJobSnapshotSeed,
} from "@dofe-agent/domain";
import { unwrapModelsInternalResponse } from "@dofe/models-sdk/response";
import { resolveModelsBaseUrl } from "../config/deployment.ts";
import { buildModelsInternalAuthorization, resolveModelsInternalConfig } from "../models/client.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";
import {
  buildRuntimeCredentialSecretRef,
  getRuntimeCredentialVault,
  type RuntimeCredentialVault,
} from "../runtime-provisioning/credential-vault.ts";

const ATTRIBUTION_KEYS = [
  "conversationId",
  "employeeId",
  "rootTaskId",
  "runtimeId",
  "sourceInvocationId",
  "traceId",
  "workspaceId",
] as const;
const DELEGATION_TTL_MS = 23 * 60 * 60 * 1000;

export class OpenMontageDelegationAuthenticationError extends Error {}
export class OpenMontageDelegationConfigurationError extends Error {}
export class OpenMontageDelegationValidationError extends Error {}

export interface BindOpenMontageJobDelegationInput extends OpenMontageJobAttribution {
  runtimeCredentialId: string;
  connectionId: string;
  channelName: string;
  conversationMessageId?: string;
  budget: { maxAmount: string; currency: string };
  snapshot: OpenMontageJobSnapshotSeed;
}

interface ModelsDelegation {
  id: string;
  runtimeCredentialId: string;
  tenantId: string;
  teamId: string;
  employeeId: string;
  conversationId: string;
  rootTaskId: string;
  sourceService: string;
  sourceInvocationId: string;
  externalJobId: string;
  allowedCapabilities: string[];
  allowedModels: string[];
  spendLimit: string | number;
  currency: string;
  status: string;
  expiresAt: string | Date;
}

interface ModelsDelegationProvision {
  delegation: ModelsDelegation;
  secret?: { apiKey: string };
  secretIssued: boolean;
}

interface CreateDelegationRequest {
  runtimeCredentialId: string;
  tenantId: string;
  teamId: string;
  idempotencyKey: string;
  employeeId: string;
  conversationId: string;
  rootTaskId: string;
  sourceService: "openmontage";
  sourceInvocationId: string;
  externalJobId: string;
  allowedCapabilities: ["video.render"];
  allowedModels: string[];
  spendLimit: string;
  currency: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export async function bindOpenMontageJobDelegationAsync(
  input: BindOpenMontageJobDelegationInput,
  options: {
    resolveScope?: (workspaceId: string) => { tenantId: string; teamId: string };
    createDelegation?: (input: CreateDelegationRequest) => Promise<ModelsDelegationProvision>;
    vault?: RuntimeCredentialVault;
    createLink?: typeof createOpenMontageJobLinkSync;
  } = {},
): Promise<{ link: OpenMontageJobLinkRecord; delegation: OpenMontageModelDelegationRecord }> {
  const scope = (options.resolveScope ?? resolveManagedRuntimeScopeSync)(input.workspaceId);
  const expiresAt = new Date(new Date(input.snapshot.createdAt).getTime() + DELEGATION_TTL_MS).toISOString();
  const request: CreateDelegationRequest = {
    runtimeCredentialId: input.runtimeCredentialId,
    tenantId: scope.tenantId,
    teamId: scope.teamId,
    idempotencyKey: `openmontage:${input.workspaceId}:${input.sourceInvocationId}`,
    employeeId: input.employeeId,
    conversationId: input.conversationId,
    rootTaskId: input.rootTaskId,
    sourceService: "openmontage",
    sourceInvocationId: input.sourceInvocationId,
    externalJobId: input.snapshot.jobId,
    allowedCapabilities: ["video.render"],
    allowedModels: [],
    spendLimit: input.budget.maxAmount,
    currency: input.budget.currency,
    expiresAt,
    metadata: { runtimeId: input.runtimeId, traceId: input.traceId },
  };
  const provision = await (options.createDelegation ?? createModelsDelegationAsync)(request);
  assertProvisionMatchesRequest(provision, request);

  const vault = options.vault ?? getRuntimeCredentialVault();
  const vaultScope = { tenantId: scope.tenantId, teamId: scope.teamId, runtimeId: input.runtimeId };
  let secretRef: string;
  if (provision.secretIssued && provision.secret?.apiKey) {
    secretRef = vault.store(provision.delegation.id, provision.secret.apiKey, vaultScope).secretRef;
  } else {
    secretRef = buildRuntimeCredentialSecretRef(provision.delegation.id, vaultScope);
    if (!vault.retrieve(secretRef, vaultScope)) {
      throw new OpenMontageDelegationConfigurationError(
        "The idempotent models delegation replay has no escrowed secret.",
      );
    }
  }

  const delegationInput: CreateOpenMontageJobLinkInput["delegation"] = {
    delegationId: provision.delegation.id,
    runtimeCredentialId: input.runtimeCredentialId,
    modelsTenantId: scope.tenantId,
    modelsTeamId: scope.teamId,
    mcpConnectionId: input.connectionId,
    secretRef,
    spendLimit: input.budget.maxAmount,
    currency: input.budget.currency,
    status: provision.delegation.status,
    expiresAt,
  };
  const link = (options.createLink ?? createOpenMontageJobLinkSync)({
    ...input,
    delegation: delegationInput,
  });
  return {
    link,
    delegation: { jobId: link.jobId, ...delegationInput, createdAt: link.createdAt, updatedAt: link.createdAt },
  };
}

export interface OpenMontageModelCredentialDocument {
  schemaVersion: 1;
  jobId: string;
  stage: string;
  delegationId: string;
  runtimeCredentialId: string;
  modelsBaseUrl: string;
  apiKey: string;
  spendLimit: string;
  currency: string;
  expiresAt: string;
}

export function issueOpenMontageModelCredential(
  input: {
    jobId: string;
    stage: string;
    headers: Headers;
    environment?: Record<string, string | undefined>;
    now?: string;
  },
  options: {
    readLink?: typeof readOpenMontageJobLinkSync;
    readDelegation?: typeof readOpenMontageModelDelegationSync;
    readProjection?: typeof readOpenMontageJobProjectionSync;
    vault?: RuntimeCredentialVault;
  } = {},
): OpenMontageModelCredentialDocument {
  const environment = input.environment ?? process.env;
  const attribution = authenticateServiceRequest(input.headers, environment.OPENMONTAGE_SERVICE_TOKEN);
  const link = (options.readLink ?? readOpenMontageJobLinkSync)(input.jobId);
  if (!link || !matchesAttribution(link, attribution)) {
    throw new OpenMontageDelegationAuthenticationError("OpenMontage Job attribution is not trusted.");
  }
  const delegation = (options.readDelegation ?? readOpenMontageModelDelegationSync)(input.jobId);
  const projection = (options.readProjection ?? readOpenMontageJobProjectionSync)(link.workspaceId, input.jobId);
  const now = input.now ?? new Date().toISOString();
  if (
    !delegation
    || delegation.status !== "active"
    || delegation.expiresAt <= now
    || !projection
    || isTerminalProjection(projection)
    || !projection.stages.some((stage) => stage.code === input.stage && ["PENDING", "RUNNING"].includes(stage.status))
  ) {
    throw new OpenMontageDelegationAuthenticationError("OpenMontage Job stage cannot receive a model credential.");
  }
  const vaultScope = {
    tenantId: delegation.modelsTenantId,
    teamId: delegation.modelsTeamId,
    runtimeId: link.runtimeId,
  };
  const apiKey = (options.vault ?? getRuntimeCredentialVault()).retrieve(delegation.secretRef, vaultScope);
  if (!apiKey) {
    throw new OpenMontageDelegationConfigurationError("OpenMontage delegated model credential is unavailable.");
  }
  return {
    schemaVersion: 1,
    jobId: link.jobId,
    stage: input.stage,
    delegationId: delegation.delegationId,
    runtimeCredentialId: delegation.runtimeCredentialId,
    modelsBaseUrl: resolveModelsBaseUrl(environment),
    apiKey,
    spendLimit: delegation.spendLimit,
    currency: delegation.currency,
    expiresAt: delegation.expiresAt,
  };
}

export async function drainOpenMontageJobDelegationAsync(
  jobId: string,
  options: {
    readDelegation?: typeof readOpenMontageModelDelegationSync;
    updateStatus?: typeof updateOpenMontageModelDelegationStatusSync;
    drainDelegation?: (delegation: OpenMontageModelDelegationRecord) => Promise<ModelsDelegation>;
  } = {},
): Promise<void> {
  const readDelegation = options.readDelegation ?? readOpenMontageModelDelegationSync;
  const updateStatus = options.updateStatus ?? updateOpenMontageModelDelegationStatusSync;
  const delegation = readDelegation(jobId);
  if (!delegation || ["draining", "revoked", "expired", "exhausted"].includes(delegation.status)) return;
  updateStatus(jobId, "drain_pending");
  const drained = await (options.drainDelegation ?? drainModelsDelegationAsync)(delegation);
  updateStatus(jobId, drained.status);
}

export async function drainPendingOpenMontageJobDelegationsAsync(
  options: {
    limit?: number;
    listJobIds?: typeof listOpenMontageDelegationDrainPendingJobIdsSync;
    drain?: typeof drainOpenMontageJobDelegationAsync;
  } = {},
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const jobIds = (options.listJobIds ?? listOpenMontageDelegationDrainPendingJobIdsSync)({
    limit: options.limit,
  });
  let succeeded = 0;
  let failed = 0;
  for (const jobId of jobIds) {
    try {
      await (options.drain ?? drainOpenMontageJobDelegationAsync)(jobId);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: jobIds.length, succeeded, failed };
}

async function createModelsDelegationAsync(input: CreateDelegationRequest): Promise<ModelsDelegationProvision> {
  const { runtimeCredentialId, ...body } = input;
  return requestModelsInternal<ModelsDelegationProvision>(
    `/internal/runtime-credentials/${encodeURIComponent(runtimeCredentialId)}/delegations`,
    body,
  );
}

async function drainModelsDelegationAsync(delegation: OpenMontageModelDelegationRecord): Promise<ModelsDelegation> {
  return requestModelsInternal<ModelsDelegation>(
    `/internal/runtime-credential-delegations/${encodeURIComponent(delegation.delegationId)}/drain`,
    {
      tenantId: delegation.modelsTenantId,
      teamId: delegation.modelsTeamId,
      idempotencyKey: `openmontage:${delegation.jobId}:drain`,
      reason: "job_terminal",
    },
  );
}

async function requestModelsInternal<T>(path: string, body: unknown): Promise<T> {
  const config = resolveModelsInternalConfig();
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: buildModelsInternalAuthorization(config),
      "x-service-name": config.serviceName,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const responseBody = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json()
    : await response.text();
  return unwrapModelsInternalResponse<T>(
    { status: response.status, body: responseBody },
    `POST ${path}`,
  );
}

function assertProvisionMatchesRequest(provision: ModelsDelegationProvision, request: CreateDelegationRequest): void {
  const delegation = provision?.delegation;
  const matches = delegation
    && delegation.runtimeCredentialId === request.runtimeCredentialId
    && delegation.tenantId === request.tenantId
    && delegation.teamId === request.teamId
    && delegation.employeeId === request.employeeId
    && delegation.conversationId === request.conversationId
    && delegation.rootTaskId === request.rootTaskId
    && delegation.sourceService === request.sourceService
    && delegation.sourceInvocationId === request.sourceInvocationId
    && delegation.externalJobId === request.externalJobId
    && canonicalDecimal(delegation.spendLimit) === canonicalDecimal(request.spendLimit)
    && delegation.currency === request.currency
    && new Date(delegation.expiresAt).toISOString() === request.expiresAt
    && delegation.status === "active"
    && delegation.allowedCapabilities.length === 1
    && delegation.allowedCapabilities[0] === "video.render"
    && delegation.allowedModels.length === 0
    && typeof delegation.id === "string"
    && delegation.id.length > 0;
  if (!matches || (provision.secretIssued && !provision.secret?.apiKey)) {
    throw new OpenMontageDelegationValidationError("models returned a delegation outside the requested Job scope.");
  }
}

function canonicalDecimal(value: string | number): string {
  const [integer = "0", fraction = ""] = String(value).split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function authenticateServiceRequest(headers: Headers, configuredToken: string | undefined): OpenMontageJobAttribution {
  const expected = configuredToken?.trim();
  if (!expected) throw new OpenMontageDelegationConfigurationError("OPENMONTAGE_SERVICE_TOKEN is required.");
  const authorization = headers.get("Authorization") ?? "";
  const actual = authorization.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
  if (!secretsMatch(expected, actual)) {
    throw new OpenMontageDelegationAuthenticationError("OpenMontage service authentication failed.");
  }
  const encoded = headers.get("X-Dofe-Job-Attribution");
  if (!encoded) throw new OpenMontageDelegationAuthenticationError("Trusted Job attribution is required.");
  try {
    const source = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    if (keys.length !== ATTRIBUTION_KEYS.length || keys.some((key, index) => key !== ATTRIBUTION_KEYS[index])) {
      throw new Error("invalid fields");
    }
    const result: Record<string, string> = {};
    for (const key of ATTRIBUTION_KEYS) {
      if (typeof source[key] !== "string" || !source[key].trim()) throw new Error("invalid value");
      result[key] = source[key];
    }
    return result as unknown as OpenMontageJobAttribution;
  } catch {
    throw new OpenMontageDelegationAuthenticationError("Trusted Job attribution is invalid.");
  }
}

function matchesAttribution(link: OpenMontageJobLinkRecord, value: OpenMontageJobAttribution): boolean {
  return ATTRIBUTION_KEYS.every((key) => link[key] === value[key]);
}

function secretsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isTerminalProjection(projection: OpenMontageJobProjection): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED"].includes(projection.status);
}
