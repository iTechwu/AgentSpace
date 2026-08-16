// 员工 Runtime 绑定 / Agent Router / 任务尝试（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type EmployeeBindingStatus,
} from "./employee-durability.ts";
import type { DaemonProvider } from "@dofe-agent/domain";

export interface EmployeeRuntimeBindingRecord {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  runtimeId: string;
  provider: DaemonProvider;
  runtimeName: string;
  /** EAD-002 binding state: online|degraded|offline|recovering|needs_attention. */
  status: EmployeeBindingStatus;
  /** Monotonic binding generation; only the current generation may write (EAD-005). */
  generation: number;
  /** The provider the control plane wants; observed runtime may differ during recovery. */
  desiredProvider?: string;
  boundAt: string;
  updatedAt: string;
}

export type AgentRouterSessionStatus = "active" | "closed";
export type AgentRouterProviderSessionStatus = "active" | "invalid" | "expired";
export type AgentRouterActorType = "human" | "agent" | "runtime" | "system";
export type AgentRouterContextSnapshotType = "context" | "memory" | "handoff";
export type AgentTaskAttemptStatus = "claimed" | "running" | "completed" | "failed" | "cancelled";

export interface AgentRouterSessionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationKey?: string;
  sourceType: string;
  status: AgentRouterSessionStatus;
  title?: string;
  summary?: string;
  memorySummary?: string;
  modelOverride?: string;
  modelOverrideSource?: string;
  modelOverrideSetAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface AgentRouterProviderSessionRecord {
  id: string;
  workspaceId: string;
  routerSessionId: string;
  runtimeId: string;
  provider: DaemonProvider;
  providerSessionId: string;
  status: AgentRouterProviderSessionStatus;
  lastUsedAt?: string;
  lastError?: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRouterEventRecord {
  id: string;
  workspaceId: string;
  routerSessionId: string;
  taskQueueId?: string;
  attemptId?: string;
  type: string;
  actorType: AgentRouterActorType;
  actorId?: string;
  runtimeId?: string;
  provider?: DaemonProvider;
  summary?: string;
  dataJson: string;
  createdAt: string;
}

export interface AgentRouterContextSnapshotRecord {
  id: string;
  workspaceId: string;
  routerSessionId: string;
  taskQueueId?: string;
  snapshotType: AgentRouterContextSnapshotType;
  contentMarkdown: string;
  sourceEventIdsJson: string;
  createdAt: string;
}

export interface AgentTaskAttemptRecord {
  id: string;
  workspaceId: string;
  taskQueueId: string;
  routerSessionId: string;
  runtimeId: string;
  provider: DaemonProvider;
  providerSessionId?: string;
  status: AgentTaskAttemptStatus;
  startedAt?: string;
  finishedAt?: string;
  errorText?: string;
  handoffSnapshotId?: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRuntimeGrantPermission = "use";
export type WorkspaceRuntimeGrantStatus = "active" | "revoked";

export interface WorkspaceRuntimeGrantRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  userId: string;
  permission: WorkspaceRuntimeGrantPermission;
  status: WorkspaceRuntimeGrantStatus;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}
