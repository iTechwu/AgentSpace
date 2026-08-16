// 员工数据持久化与恢复（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


export interface EmployeePersistentWorkspaceRecord {
  id: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  headRevisionId?: string;
  storageRef?: string;
  retentionPolicyJson: string;
  storageHealth: string;
  lastSnapshotAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRevisionStatus = "pending" | "committed" | "needs_attention";

export interface EmployeeWorkspaceRevisionRecord {
  id: string;
  workspaceId: string;
  workspaceIdRef: string;
  employeeId: string;
  employeeName: string;
  parentRevisionId?: string;
  manifestDigest: string;
  manifestJson: string;
  sourceTaskId?: string;
  status: WorkspaceRevisionStatus;
  /** `task_output` (explicit attachments) or `workdir_snapshot` (workDir capture). */
  sourceKind: string;
  /** Immutable source revision when sourceKind is `history_restore`. */
  restoredFromRevisionId?: string;
  createdBy?: string;
  createdAt: string;
}

export interface EmployeeArtifactRecord {
  id: string;
  workspaceId: string;
  workspaceIdRef: string;
  employeeId: string;
  employeeName: string;
  contentDigest: string;
  mediaType: string;
  fileName: string;
  sizeBytes: number;
  sourceTaskId?: string;
  publishedAt: string;
  deletedAt?: string;
}

export type EmployeeDataLegalHoldResourceType =
  | "employee_workspace"
  | "artifact"
  | "revision"
  | "content_blob";

export interface EmployeeDataLegalHoldRecord {
  id: string;
  workspaceId: string;
  employeeId?: string;
  resourceType: EmployeeDataLegalHoldResourceType;
  resourceId: string;
  reason: string;
  /** Legal case / ticket reference (e.g. "LEG-2026-0142") for the hold. */
  caseReference?: string;
  createdByUserId?: string;
  createdByDisplayName?: string;
  createdAt: string;
  expiresAt?: string;
  releasedAt?: string;
  releasedByUserId?: string;
  releaseReason?: string;
}

export interface EmployeeDurabilityUsageRecord {
  workspaceId: string;
  employeeId: string;
  blobCount: number;
  totalBytes: number;
  artifactCount: number;
  revisionCount: number;
}

export interface BackupRestoreDrillRunRecord {
  id: string;
  workspaceId: string;
  drillType: "metadata" | "external_restore";
  trigger: "manual" | "cron";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  resultJson: string;
  errorMessage?: string;
  /** For external_restore drills: the PostgreSQL PITR restore point this run verified. */
  restorePointAt?: string;
  /** For external_restore drills: the source backup/snapshot identifier. */
  sourceSnapshot?: string;
  /** For external_restore drills: the scratch/isolated environment identifier. */
  restoreEnvironment?: string;
  /** For external_restore drills: measured restore duration in milliseconds (RTO). */
  restoreDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskCommitState = "preparing" | "committed" | "rolled_back";

export interface TaskCommitJournalRecord {
  taskId: string;
  workspaceId: string;
  employeeId?: string;
  employeeName?: string;
  workspaceRevisionId?: string;
  artifactIdsJson: string;
  commitState: TaskCommitState;
  attempt: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type EmployeeBindingStatus =
  | "online"
  | "degraded"
  | "offline"
  | "recovering"
  | "needs_attention";

export type RecoveryPhase =
  | "allocate"
  | "mount_workspace"
  | "install_skills"
  | "resolve_secrets"
  | "health_check"
  | "activate"
  | "completed"
  | "failed";

export interface EmployeeRecoveryOperationRecord {
  id: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  fromGeneration?: number;
  toGeneration: number;
  phase: RecoveryPhase;
  targetRevisionId?: string;
  requestedByUserId?: string;
  errorCode?: string;
  errorMessage?: string;
  contextJson: string;
  /** In-flight managed-runtime provisioning task handle for the async allocate step. */
  provisioningTaskId?: string;
  /** In-flight daemon workspace-mount operation handle for the async mount step. */
  mountOperationId?: string;
  healthCheckedAt?: string;
  approvalState?: "not_required" | "pending" | "approved" | "rejected";
  approvedByUserId?: string;
  approvedAt?: string;
  /** Number of admin approvals required before the recovery worker may proceed. */
  requiredApprovals?: number;
  /** Current count of recorded approvals. */
  approvalCount?: number;
  /** Ordered list of {userId, approvedAt} approvals recorded so far. */
  approvers?: Array<{ userId: string; approvedAt: string }>;
  actorUserId?: string;
  createdAt: string;
  updatedAt: string;
}
