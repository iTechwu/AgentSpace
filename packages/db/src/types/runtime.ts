// Daemon / Runtime / 供给 / SSO / 凭据（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import type { DaemonProvider } from "@dofe-agent/domain";

export interface AgentRuntimeRecord {
  id: string;
  workspaceId: string;
  daemonConnectionId?: string;
  provider: DaemonProvider;
  providerAccountId?: string;
  name: string;
  version: string;
  status: "online" | "offline";
  deviceInfo: string;
  metadataJson: string;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
  /**
   * Managed-runtime lifecycle marker. `managed` = provisioned through a
   * RuntimeProvisioningTask with a models.dofe.ai RuntimeCredential;
   * `legacy` = backed by a provider_account. Null for rows created before
   * the managed-runtime phase.
   */
  provisioningState?: "managed" | "draining" | "legacy" | "credential_recovering" | "needs_attention" | null;
  /** models.dofe.ai RuntimeCredential id (opaque). */
  managedCredentialId?: string;
  /** Opaque vault references; plaintext keys are never stored. */
  credentialSecretRef?: string;
  credentialConfigRef?: string;
  /** Protocol capability of the managed runtime (e.g. anthropic / openai / gemini). */
  protocols?: string[];
  /** Runtime-level default model suggestion. */
  defaultModel?: string;
  /**
   * Whether additional AI employees may bind to this managed runtime. Existing
   * bindings are preserved when false; only new binds are refused. Defaults to
   * true (one runtime serving many employees is the baseline model). Optional
   * in the type because partial record fixtures omit it; the DB column is
   * NOT NULL DEFAULT TRUE and the record mapper always returns a boolean.
   */
  allowNewEmployeeSharing?: boolean;
  provisioningTaskId?: string;
  managedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRuntimeDisplayNameRecord {
  workspaceId: string;
  runtimeId: string;
  displayName: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRegistrationInput {
  provider: DaemonProvider;
  providerAccountId?: string;
  name: string;
  version?: string;
  deviceInfo?: string;
  metadata?: Record<string, unknown>;
}

export type ProviderAccountStatus = "active" | "inactive" | "legacy";

export interface ProviderAccountRecord {
  id: string;
  workspaceId: string;
  provider: DaemonProvider;
  name: string;
  billingAccountId?: string;
  secretRef?: string;
  configRef?: string;
  allowedModels: string[];
  status: ProviderAccountStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeProvisionRequestStatus = "requested" | "approved" | "cancelled" | "fulfilled";

export interface RuntimeProvisionRequestRecord {
  id: string;
  workspaceId: string;
  providerAccountId: string;
  provider: DaemonProvider;
  runtimeName: string;
  targetServer: string;
  status: RuntimeProvisionRequestStatus;
  requestedBy: string;
  approvedBy?: string;
  daemonTokenId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Managed Runtime provisioning (Phase 2) ────────────────────────────────

/** Persisted SSO tenant/team binding for a workspace, used to resolve the
 *  models.dofe.ai tenantId/teamId when provisioning managed runtimes. */
export type WorkspaceSsoBindingSource = "team" | "tenant";

export interface WorkspaceSsoBindingRecord {
  workspaceId: string;
  tenantId: string;
  tenantSlug?: string;
  tenantName: string;
  /** Present for team-scoped workspaces; null for tenant-only scopes. */
  teamId?: string;
  teamSlug?: string;
  teamName?: string;
  source: WorkspaceSsoBindingSource;
  syncedAt: string;
}

export type RuntimeProvisioningTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "retrying"
  | "cancelling"
  | "cancelled";

/** Stage enum is forward-compatible with the docs/0727 spec. `pull_image` and
 *  `install_cli` are recorded as `skipped` in Phase 2 (node-side install is
 *  Phase 3); the rest are driven by the provisioning orchestrator. */
export type RuntimeProvisioningTaskStage =
  | "pending"
  | "request_credential"
  | "prepare_node"
  | "pull_image"
  | "install_cli"
  | "write_credential"
  | "health_check"
  | "ready";

export type RuntimeProvisioningTaskStageStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type RuntimeProvisioningTaskCleanupStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface RuntimeProvisioningTaskRecord {
  id: string;
  workspaceId: string;
  /** Filled once the agent_runtime row is created at prepare_node. */
  runtimeId?: string;
  requestedByUserId: string;
  /** Unique per (workspace, key); re-submitting returns the same task. */
  idempotencyKey: string;
  /** For reuse/retry lineage. */
  sourceRuntimeId?: string;
  runtimeType: DaemonProvider;
  protocols: string[];
  requestedName?: string;
  requestedModel?: string;
  allowedModels: string[];
  targetServer?: string;
  stage: RuntimeProvisioningTaskStage;
  stageStatus: RuntimeProvisioningTaskStageStatus;
  progressPercent: number;
  retryCount: number;
  maxRetries: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  cleanupStatus: RuntimeProvisioningTaskCleanupStatus;
  cleanupResultJson?: string;
  /** models.dofe.ai RuntimeCredential id (opaque), set at request_credential. */
  runtimeCredentialId?: string;
  /** Opaque vault references; plaintext keys are never stored. */
  secretRef?: string;
  configRef?: string;
  /** Daemon connection that has claimed the current node-side stage. */
  daemonConnectionId?: string;
  /** When the current stage was claimed / started running on a node. */
  stageStartedAt?: string;
  status: RuntimeProvisioningTaskStatus;
  /** Per-stage timeouts in ms, keyed by stage. */
  timeoutsJson?: string;
  /** Overall task timeout in ms. */
  taskTimeoutMs?: number;
  /** When a retrying task should be rescheduled. */
  nextRetryAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type RuntimeProvisioningTaskEventSeverity = "info" | "warning" | "error";

export interface RuntimeProvisioningTaskEventRecord {
  id: string;
  taskId: string;
  stage: RuntimeProvisioningTaskStage;
  status: RuntimeProvisioningTaskStageStatus;
  progressPercent: number;
  title: string;
  summary?: string;
  severity: RuntimeProvisioningTaskEventSeverity;
  dataJson?: string;
  createdAt: string;
}

export type RuntimeCredentialRecoveryTaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface RuntimeCredentialRecoveryTaskRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  sourceTaskId: string;
  credentialId: string;
  idempotencyKey: string;
  status: RuntimeCredentialRecoveryTaskStatus;
  attemptCount: number;
  maxAttempts: number;
  cooldownUntil?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ManagedRuntimeCleanupRequestStatus = "pending" | "running" | "succeeded" | "failed";

export interface ManagedRuntimeCleanupRequestRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  daemonConnectionId: string;
  runtimeType: DaemonProvider;
  provisioningTaskId?: string;
  deleteRuntimeOnSuccess: boolean;
  status: ManagedRuntimeCleanupRequestStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  claimedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  requestedAt: string;
  completedAt?: string;
  resultJson?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Immutable audit log ────────────────────────────────────────────────────
