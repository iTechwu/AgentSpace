import {
  listOpenMontageModelDelegationsForMcpConnectionSync,
  listOpenMontageModelDelegationsForRuntimeSync,
  readOpenMontageMcpPurgeGuardSync,
  readOpenMontageRuntimePurgeGuardSync,
  updateOpenMontageModelDelegationStatusSync,
  type OpenMontageModelDelegationRecord,
  type OpenMontagePurgeGuardSnapshot,
} from "@dofe-agent/db";
import { unwrapModelsInternalResponse } from "@dofe/models-sdk/response";
import {
  buildModelsInternalAuthorization,
  resolveModelsInternalConfig,
} from "../models/client.ts";

export class OpenMontagePurgeBlockedError extends Error {
  readonly targetType: "runtime" | "mcp_connection";
  readonly targetId: string;
  readonly guard: OpenMontagePurgeGuardSnapshot;

  constructor(
    targetType: "runtime" | "mcp_connection",
    targetId: string,
    guard: OpenMontagePurgeGuardSnapshot,
    message = "openmontage.purge_blocked",
  ) {
    super(message);
    this.targetType = targetType;
    this.targetId = targetId;
    this.guard = guard;
  }
}

type ReadRemoteDelegation = (
  delegation: OpenMontageModelDelegationRecord,
) => Promise<{
  status: string;
  reservedSpend: string | number;
  providerReconciledThrough?: string | null;
}>;

export async function assertOpenMontageRuntimePurgeableAsync(
  input: { workspaceId: string; runtimeId: string },
  options: { readRemoteDelegation?: ReadRemoteDelegation } = {},
): Promise<void> {
  await assertPurgeableAsync({
    targetType: "runtime",
    targetId: input.runtimeId,
    readLocal: () => readOpenMontageRuntimePurgeGuardSync(input.workspaceId, input.runtimeId),
    listDelegations: () => listOpenMontageModelDelegationsForRuntimeSync(input.workspaceId, input.runtimeId),
    readRemoteDelegation: options.readRemoteDelegation,
  });
}

export async function assertOpenMontageMcpPurgeableAsync(
  input: { workspaceId: string; connectionId: string },
  options: { readRemoteDelegation?: ReadRemoteDelegation } = {},
): Promise<void> {
  await assertPurgeableAsync({
    targetType: "mcp_connection",
    targetId: input.connectionId,
    readLocal: () => readOpenMontageMcpPurgeGuardSync(input.workspaceId, input.connectionId),
    listDelegations: () => listOpenMontageModelDelegationsForMcpConnectionSync(input.workspaceId, input.connectionId),
    readRemoteDelegation: options.readRemoteDelegation,
  });
}

export function assertOpenMontageRuntimePurgeableSync(input: {
  workspaceId: string;
  runtimeId: string;
}): void {
  assertLocalPurgeable("runtime", input.runtimeId, readOpenMontageRuntimePurgeGuardSync(
    input.workspaceId,
    input.runtimeId,
  ));
}

export function assertOpenMontageMcpPurgeableSync(input: {
  workspaceId: string;
  connectionId: string;
}): void {
  assertLocalPurgeable("mcp_connection", input.connectionId, readOpenMontageMcpPurgeGuardSync(
    input.workspaceId,
    input.connectionId,
  ));
}

async function assertPurgeableAsync(input: {
  targetType: "runtime" | "mcp_connection";
  targetId: string;
  readLocal: () => OpenMontagePurgeGuardSnapshot;
  listDelegations: () => OpenMontageModelDelegationRecord[];
  readRemoteDelegation?: ReadRemoteDelegation;
}): Promise<void> {
  const initial = input.readLocal();
  if (initial.inFlightJobIds.length > 0 || initial.unreconciledUsageCount > 0) {
    throw new OpenMontagePurgeBlockedError(input.targetType, input.targetId, initial);
  }
  const readRemote = input.readRemoteDelegation ?? readModelsDelegationAsync;
  for (const delegation of input.listDelegations()) {
    const remote = await readRemote(delegation);
    updateOpenMontageModelDelegationStatusSync(delegation.jobId, remote.status);
    if (
      !["revoked", "expired", "exhausted"].includes(remote.status)
      || Number(remote.reservedSpend) !== 0
      || !remote.providerReconciledThrough
    ) {
      throw new OpenMontagePurgeBlockedError(
        input.targetType,
        input.targetId,
        input.readLocal(),
        "openmontage.models_delegation_not_finalized",
      );
    }
  }
  assertLocalPurgeable(input.targetType, input.targetId, input.readLocal());
}

function assertLocalPurgeable(
  targetType: "runtime" | "mcp_connection",
  targetId: string,
  guard: OpenMontagePurgeGuardSnapshot,
): void {
  if (!guard.purgeable) {
    throw new OpenMontagePurgeBlockedError(targetType, targetId, guard);
  }
}

async function readModelsDelegationAsync(delegation: OpenMontageModelDelegationRecord) {
  const config = resolveModelsInternalConfig();
  const url = new URL(
    `/internal/runtime-credential-delegations/${encodeURIComponent(delegation.delegationId)}`,
    config.baseUrl,
  );
  url.searchParams.set("tenantId", delegation.modelsTenantId);
  url.searchParams.set("teamId", delegation.modelsTeamId);
  const response = await fetch(url, {
    headers: {
      authorization: buildModelsInternalAuthorization(config),
      "x-service-name": config.serviceName,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const body = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json()
    : await response.text();
  return unwrapModelsInternalResponse<{
    status: string;
    reservedSpend: string | number;
    providerReconciledThrough?: string | null;
  }>({ status: response.status, body }, `GET ${url.pathname}`);
}
