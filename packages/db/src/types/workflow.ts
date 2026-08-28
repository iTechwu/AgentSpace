// 工作流定义 / 版本 / 运行（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type EmployeeBindingStatus,
  type RecoveryPhase,
  type TaskCommitState,
  type WorkspaceRevisionStatus,
} from "./employee-durability.ts";

export interface WorkflowDefinitionRecord {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  ownerUserId: string;
  channelName?: string;
  status: "draft" | "published" | "paused" | "archived";
  draftGraphJson: string;
  draftVersion: number;
  activeVersionId?: string;
  legacySourceType?: string;
  legacySourceId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface WorkflowVersionRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: string;
  inputSchemaJson: string;
  outputSchemaJson: string;
  governanceJson: string;
  contentHash: string;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
}

export interface WorkflowTriggerRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  type: "manual" | "schedule" | "event";
  configJson: string;
  timezone?: string;
  status: string;
  nextFireAt?: string;
  lastFireAt?: string;
  misfirePolicy: "skip" | "fire_once";
  dedupeWindowSeconds: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  rootTaskId?: string;
  triggerId?: string;
  triggerType: string;
  triggerKey: string;
  inputJson: string;
  status: string;
  currentSequence: number;
  budgetJson: string;
  startedAt?: string;
  finishedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNodeRunRecord {
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  employeeId?: string;
  employeeNameSnapshot?: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt?: string;
  taskQueueId?: string;
  approvalId?: string;
  approvalDeadline?: string;
  approvalScanAfter?: string;
  inputJson: string;
  outputJson?: string;
  artifactManifestJson?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunEventRecord {
  id: string;
  workspaceId: string;
  runId: string;
  nodeRunId?: string;
  sequence: number;
  type: string;
  actorType: string;
  actorId?: string;
  severity: string;
  dataJson: string;
  createdAt: string;
}

export interface WorkflowOutboxRecord {
  id: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadJson: string;
  status: string;
  attempts: number;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  publishedAt?: string;
}

export function isWorkspaceRevisionStatus(value: unknown): value is WorkspaceRevisionStatus {
  return value === "pending" || value === "committed" || value === "needs_attention";
}

export function isTaskCommitState(value: unknown): value is TaskCommitState {
  return value === "preparing" || value === "committed" || value === "rolled_back";
}

export function isEmployeeBindingStatus(value: unknown): value is EmployeeBindingStatus {
  return (
    value === "online" ||
    value === "degraded" ||
    value === "offline" ||
    value === "recovering" ||
    value === "needs_attention"
  );
}

export function isRecoveryPhase(value: unknown): value is RecoveryPhase {
  return (
    value === "allocate" ||
    value === "mount_workspace" ||
    value === "install_skills" ||
    value === "resolve_secrets" ||
    value === "health_check" ||
    value === "activate" ||
    value === "completed" ||
    value === "failed"
  );
}

/** ─── Capability request (docs/0811/cli-install unified task) ─── */
