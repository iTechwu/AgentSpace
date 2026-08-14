// 供给容量与申请入口：actor 断言、作用域解析、容量复用与供给申请。
import {
  listDaemonSnapshotsSync,
  listManagedAgentRuntimesSync,
  readWorkspaceSsoBindingSync,
} from "@dofe-agent/db";
import type {
  AgentRuntimeRecord,
  RuntimeProvisioningTaskRecord,
  WorkspaceSsoBindingRecord,
} from "@dofe-agent/db";
import {
  resolveProviderDefaultModel,
  resolveProviderProtocols,
} from "@dofe-agent/domain";
import type {
  DaemonProvider,
} from "@dofe-agent/domain";
import {
  resolveAgentRuntimeMode,
} from "../config/deployment.ts";
import {
  isWorkspaceAdminOrOwnerSync,
} from "../runtime-access/runtime-access.ts";
import {
  tryRecordWorkspaceAuditEventSync,
} from "../shared/audit.ts";

export const MANAGED_RUNTIME_NAME_PREFIX = "Managed";

export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_CLEANUP_TIMEOUT_MS = 10 * 60 * 1000;

const RETRY_BACKOFF_BASE_MS = 15_000;

const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;

export const DEFAULT_CREDENTIAL_RECONCILIATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function resolveManagedRuntimeDefaultModel(provider: DaemonProvider, requestedModel?: string): string | undefined {
  return requestedModel?.trim() || resolveProviderDefaultModel(provider);
}

export function resolveManagedRuntimeAllowedModels(provider: DaemonProvider, requestedModels?: string[]): string[] {
  // An empty Models credential allowlist delegates filtering to team policy,
  // protocol compatibility and availability. Responses runtimes need that
  // dynamic catalog so an employee model does not become the sole allowed one.
  if (resolveProviderProtocols(provider).includes("openai_response")) {
    return [];
  }
  return [...new Set((requestedModels ?? []).map((model) => model.trim()).filter(Boolean))];
}

function computeRetryBackoffMs(retryCount: number): number {
  const jitter = Math.random() * 0.4 + 0.8;
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** retryCount) * jitter;
}

// ─── Role + scope resolution ────────────────────────────────────────────────

export interface ManagedRuntimeActor {
  workspaceId: string;
  actorUserId: string;
}

export function assertCanManageManagedRuntimes(input: ManagedRuntimeActor): void {
  if (
    !isWorkspaceAdminOrOwnerSync({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    })
  ) {
    throw new Error("Only workspace owners and admins can manage managed runtimes.");
  }
}

export function assertRemoteRuntimeMode(): void {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("managed_runtime.remote_mode_required");
  }
}

/**
 * Managed runtimes bill to a models.dofe.ai (tenantId, teamId), so the
 * workspace must be SSO team-scoped. Tenant-only workspaces (no teamId) are
 * rejected.
 */

export function resolveManagedRuntimeScopeSync(
  workspaceId: string,
): { binding: WorkspaceSsoBindingRecord; tenantId: string; teamId: string } {
  const binding = readWorkspaceSsoBindingSync(workspaceId);
  if (!binding) {
    throw new Error("managed_runtime.sso_binding_required");
  }
  if (!binding.teamId) {
    throw new Error("managed_runtime.team_scoped_workspace_required");
  }
  return { binding, tenantId: binding.tenantId, teamId: binding.teamId };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RequestManagedRuntimeInput extends ManagedRuntimeActor {
  provider: DaemonProvider;
  defaultModel?: string;
  protocols?: string[];
  allowedModels?: string[];
  idempotencyKey: string;
  targetServer?: string;
  name?: string;
  /** When false, the created runtime refuses new employee binds (default true). */
  allowNewEmployeeSharing?: boolean;
}

export interface EnsureManagedRuntimeCapacityInput extends RequestManagedRuntimeInput {
  /** Skip compatible shared runtimes and provision an isolated runtime. */
  forceProvisioning?: boolean;
}

export type ManagedRuntimeCapacityResult =
  | { kind: "reused"; runtimeId: string; runtimeName: string }
  | { kind: "provisioning"; task: RuntimeProvisioningTaskRecord };

export interface ManagedExecutionNode {
  deviceName: string;
  status: "online" | "offline";
}

export function listManagedExecutionNodesSync(
  input: ManagedRuntimeActor,
): ManagedExecutionNode[] {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const nodes = new Map<string, ManagedExecutionNode>();
  for (const { daemon } of listDaemonSnapshotsSync(input.workspaceId)) {
    if (!isManagedExecutionNodeMetadata(daemon.metadataJson)) continue;
    const current = nodes.get(daemon.deviceName);
    if (!current || daemon.status === "online") {
      nodes.set(daemon.deviceName, {
        deviceName: daemon.deviceName,
        status: daemon.status,
      });
    }
  }
  return [...nodes.values()].sort((left, right) => left.deviceName.localeCompare(right.deviceName));
}

export function findReusableManagedRuntime(
  input: Pick<EnsureManagedRuntimeCapacityInput, "workspaceId" | "provider" | "protocols" | "defaultModel" | "targetServer">,
): AgentRuntimeRecord | undefined {
  const requiredProtocols = input.protocols?.length
    ? input.protocols
    : resolveProviderProtocols(input.provider);
  const requestedModel = resolveManagedRuntimeDefaultModel(input.provider, input.defaultModel);
  const targetRuntimeIds = input.targetServer
    ? new Set(
        listDaemonSnapshotsSync(input.workspaceId)
          .filter(({ daemon }) => daemon.deviceName === input.targetServer)
          .flatMap(({ runtimes }) => runtimes.map((runtime) => runtime.id)),
      )
    : undefined;

  return listManagedAgentRuntimesSync(input.workspaceId).find((runtime) =>
    runtime.provider === input.provider
    && runtime.status === "online"
    && runtime.provisioningState === "managed"
    && runtime.allowNewEmployeeSharing !== false
    && requiredProtocols.every((protocol) => runtime.protocols?.includes(protocol))
    && (!requestedModel || runtime.defaultModel === requestedModel)
    && (!targetRuntimeIds || targetRuntimeIds.has(runtime.id)),
  );
}

function isManagedExecutionNodeMetadata(value: string): boolean {
  try {
    const metadata = JSON.parse(value) as unknown;
    return Boolean(
      metadata
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && (metadata as Record<string, unknown>).managedNode === true,
    );
  } catch {
    return false;
  }
}
