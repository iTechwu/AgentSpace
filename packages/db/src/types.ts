// ─── New multi-tenant types ───────────────────────────────────────────────

/** A workspace — the primary isolation boundary */
export interface StoredWorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** Membership tying a user to a workspace with a role */
export type WorkspaceRole = "owner" | "admin" | "member";

export interface StoredWorkspaceMembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: "active" | "invited" | "removed";
  joinedAt: string;
  invitedBy?: string;
}

/** The new user table — replaces auth_user */
export interface StoredUserRecord {
  id: string;
  displayName: string;
  avatarUrl?: string;
  primaryEmail?: string;
  isAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/** A Dofe SSO identity linked to a local workspace user. */
export type AuthProvider = "sso";

export interface StoredAuthIdentityRecord {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email?: string;
  emailVerified: boolean;
  profileJson: string;
  createdAt: string;
  updatedAt: string;
}

/** Server-side session (replaces auth_session token model) */
export interface StoredSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
  ipAddress?: string;
  userAgent?: string;
  revokedAt?: string;
}

export type ExternalIntegrationProvider = string;
export type ExternalIntegrationStatus = "active" | "disabled" | "error";
export type ExternalIntegrationTransportMode = "http_webhook" | "websocket_worker";
export type ExternalIntegrationHealthStatus = "unknown" | "healthy" | "degraded" | "error";

export interface ExternalIntegrationRecord {
  id: string;
  workspaceId: string;
  provider: ExternalIntegrationProvider;
  displayName: string;
  status: ExternalIntegrationStatus;
  transportMode: ExternalIntegrationTransportMode;
  agentId?: string;
  appId?: string;
  tenantKey?: string;
  encryptedCredentialsJson: string;
  configJson: string;
  capabilitiesJson: string;
  scopesJson: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
  lastHealthStatus?: ExternalIntegrationHealthStatus;
  lastHealthCheckedAt?: string;
  lastError?: string;
}

export type ExternalBindingStatus = "active" | "disabled" | "archived";

export interface ExternalUserBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  userId: string;
  externalUserId: string;
  externalUnionId?: string;
  externalOpenId?: string;
  externalEmail?: string;
  displayName?: string;
  status: ExternalBindingStatus;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export type ExternalChannelBindingSyncMode = "mirror" | "ingest_only" | "send_only";

export interface ExternalChannelBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelName: string;
  externalChatId: string;
  externalChatType?: string;
  externalChatName?: string;
  status: ExternalBindingStatus;
  syncMode: ExternalChannelBindingSyncMode;
  metadataJson: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

export type ExternalResourceBindingProviderType = string;
export type ExternalResourceBindingDofeAgentType = string;

export interface ExternalResourceBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  providerResourceUrl?: string;
  dofeAgentResourceType: ExternalResourceBindingDofeAgentType;
  dofeAgentResourceId: string;
  channelName?: string;
  displayName?: string;
  status: ExternalBindingStatus;
  permissionsJson: string;
  metadataJson: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ExternalMessageDirection = "inbound" | "outbound";

export interface ExternalMessageMappingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  direction: ExternalMessageDirection;
  externalMessageId: string;
  externalThreadId?: string;
  externalSenderId?: string;
  externalEventId?: string;
  dofeAgentMessageId?: string;
  taskQueueId?: string;
  routerSessionId?: string;
  metadataJson: string;
  createdAt: string;
}

export type ExternalMessageOutboxStatus = "pending" | "locked" | "sent" | "failed" | "cancelled";

export interface ExternalMessageOutboxRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  targetExternalChatId: string;
  targetExternalThreadId?: string;
  dofeAgentMessageId?: string;
  payloadJson: string;
  metadataJson: string;
  status: ExternalMessageOutboxStatus;
  attempts: number;
  nextAttemptAt?: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export type ExternalThreadBindingStatus = "active" | "closed" | "archived";

export interface ExternalThreadBindingRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  channelBindingId?: string;
  provider: ExternalIntegrationProvider;
  tenantKey?: string;
  externalChatId: string;
  externalThreadId: string;
  channelName: string;
  agentId: string;
  taskQueueId?: string;
  dofeAgentMessageId?: string;
  status: ExternalThreadBindingStatus;
  metadataJson: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalDataOperationRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type ExternalDataOperationActorType = "user" | "agent" | "system";

export interface ExternalDataOperationRunRecord {
  id: string;
  workspaceId: string;
  integrationId: string;
  resourceBindingId?: string;
  operationType: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  actorType: ExternalDataOperationActorType;
  actorId?: string;
  status: ExternalDataOperationRunStatus;
  requestJson: string;
  resultJson: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalIntegrationEventStatus = "received" | "processed" | "ignored" | "failed";

export interface ExternalIntegrationEventRecord {
  id: string;
  workspaceId: string;
  integrationId?: string;
  provider: ExternalIntegrationProvider;
  externalEventId: string;
  eventType: string;
  status: ExternalIntegrationEventStatus;
  payloadJson: string;
  errorMessage?: string;
  receivedAt: string;
  processedAt?: string;
}

import type { DaemonProvider } from "@dofe-agent/domain";
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";

export interface DaemonConnectionRecord {
  id: string;
  workspaceId: string;
  daemonKey: string;
  deviceName: string;
  status: "online" | "offline";
  metadataJson: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}

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
  provisioningState?: "managed" | "legacy" | "credential_recovering" | "needs_attention" | null;
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

export type AuditLogSource =
  | "workspace_snapshot_ledger"
  | "runtime_credential"
  | "runtime_lifecycle"
  | "runtime_model"
  | "platform_admin";

export interface AuditLogRecord {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code?: string;
  dataJson: string;
  source: AuditLogSource;
  sourceIndex: number;
  createdAt: string;
}

export interface RegisteredDaemonSnapshot {
  daemon: DaemonConnectionRecord;
  runtimes: AgentRuntimeRecord[];
}

export interface DaemonApiTokenRecord {
  id: string;
  workspaceId: string;
  daemonConnectionId?: string;
  label: string;
  tokenHash: string;
  purpose: DaemonApiTokenPurpose;
  status: "active" | "revoked";
  createdBy: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export type DaemonApiTokenPurpose = "general" | "managed_node_bootstrap";

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

export type DocumentAgentAccessRole = "forwarder" | "editor" | "viewer";
export type DocumentAgentAccessSubjectType = "agent";

export interface DocumentAgentAccessRecord {
  id: string;
  workspaceId: string;
  documentId: string;
  subjectType: DocumentAgentAccessSubjectType;
  subjectId: string;
  role: DocumentAgentAccessRole;
  scope: "document";
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export type DocumentPermissionRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type DocumentPermissionRequestExternalProvider = "notion" | "microsoft_365";

export interface DocumentPermissionRequestRecord {
  id: string;
  workspaceId: string;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  externalUrl?: string;
  requestedRole: DocumentAgentAccessRole;
  requestedByAgentName: string;
  requestedForChannelName?: string;
  triggeredByUserId?: string;
  reason: string;
  status: DocumentPermissionRequestStatus;
  decidedByUserId?: string;
  decisionNote?: string;
  sourceTaskId?: string;
  createdAt: string;
  decidedAt?: string;
}

export type AgentAccessRequestType = "fork_copy" | "channel_use";
export type AgentAccessRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface AgentAccessRequestRecord {
  id: string;
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType: AgentAccessRequestType;
  targetChannelName?: string;
  status: AgentAccessRequestStatus;
  reason: string;
  resolverUserId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  forkInvitationId?: string;
  auditDataJson: string;
}

export type KnowledgeProposalOperation = "create" | "update";
export type KnowledgeProposalStatus = "pending" | "approved" | "rejected" | "stale" | "cancelled";

export interface KnowledgeProposalRecord {
  id: string;
  workspaceId: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
  sourceAgentName: string;
  operation: KnowledgeProposalOperation;
  status: KnowledgeProposalStatus;
  title: string;
  contentMarkdown: string;
  summary?: string;
  reason?: string;
  tags: string[];
  parentId?: string;
  assignmentMode: KnowledgeAssignmentMode;
  assignedEmployeeNames: string[];
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
  createdKnowledgePageId?: string;
  approvalId?: string;
  decidedByUserId?: string;
  decidedAt?: string;
  reviewerComment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResetKnowledgeProposalsResult {
  removedKnowledgeProposalRows: number;
}

export type WorkspaceNotificationRecipientType = "human" | "agent";
export type WorkspaceNotificationActorType = "human" | "agent" | "system";
export type WorkspaceNotificationResourceType =
  | "workspace"
  | "workspace_member"
  | "agent"
  | "agent_fork_invitation"
  | "channel"
  | "document"
  | "runtime"
  | "task"
  | "approval"
  | "data_protection"
  | "skill";
export type WorkspaceNotificationSeverity = "info" | "success" | "warning" | "critical";
export type WorkspaceNotificationStatus = "unread" | "read" | "archived";

export interface WorkspaceNotificationRecord {
  id: string;
  workspaceId: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
  actorType?: WorkspaceNotificationActorType;
  actorId?: string;
  type: string;
  resourceType: WorkspaceNotificationResourceType;
  resourceId?: string;
  channelName?: string;
  title: string;
  body: string;
  actionHref?: string;
  severity: WorkspaceNotificationSeverity;
  status: WorkspaceNotificationStatus;
  dedupeKey?: string;
  metadataJson: string;
  createdAt: string;
  readAt?: string;
  archivedAt?: string;
}

export type AgentForkInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface StoredAgentForkInvitationRecord {
  id: string;
  workspaceId: string;
  sourceAgentName: string;
  targetUserId: string;
  status: AgentForkInvitationStatus;
  optionsJson: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  acceptedAgentName?: string;
  acceptedRuntimeId?: string;
}

export interface StoredAgentForkSnapshotRecord {
  id: string;
  workspaceId: string;
  invitationId: string;
  sourceAgentName: string;
  snapshotJson: string;
  createdAt: string;
}

export type RuntimeAppCatalogSource = "clihub_harness" | "clihub_public" | "skill_dependency" | "workspace_private";
export type RuntimeAppInstallStrategy = "cli_hub" | "pip" | "npm" | "uv" | "system" | "bundled" | "manual";
export type RuntimeInstalledAppStatus = "installed" | "installing" | "failed" | "disabled" | "missing";
export type RuntimeAppOperationType = "install" | "update" | "uninstall" | "verify" | "disable" | "enable";
export type RuntimeAppOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeAppOperationStage = "queued" | "installing" | "verifying" | "finalizing" | "completed";
export type RuntimeAppRiskLevel = "low" | "medium" | "high";
export type RuntimeAppArtifactKind = "npm" | "pypi";

export interface WorkspaceRuntimeAppPackageRecord {
  id: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  homepage?: string;
  createdByUserId?: string;
  createdAt: string;
}

export interface WorkspaceRuntimeAppReleaseRecord {
  id: string;
  workspaceId: string;
  packageId: string;
  packageSlug: string;
  displayName: string;
  description: string;
  category: string;
  homepage?: string;
  version: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  artifactUrl: string;
  artifactIntegrity: string;
  entryPoint: string;
  manifestJson: string;
  risk: RuntimeAppRiskLevel;
  createdByUserId?: string;
  createdAt: string;
  yankedAt?: string;
}

export interface RuntimeAppCatalogItemRecord {
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  entryPoint: string;
  installStrategy: RuntimeAppInstallStrategy | "";
  installCmd?: string;
  uninstallCmd?: string;
  updateCmd?: string;
  skillMd?: string;
  requiresText?: string;
  homepage?: string;
  registryJson: string;
  syncedAt: string;
}

export interface RuntimeInstalledAppRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  version: string;
  entryPoint: string;
  status: RuntimeInstalledAppStatus;
  installStrategy: RuntimeAppInstallStrategy | "";
  enabled: boolean;
  installedByUserId?: string;
  installedAt?: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastError?: string;
  metadataJson: string;
}

export interface RuntimeAppOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  appSource: RuntimeAppCatalogSource;
  appName: string;
  operation: RuntimeAppOperationType;
  status: RuntimeAppOperationStatus;
  stage: RuntimeAppOperationStage;
  failedStage?: RuntimeAppOperationStage;
  stageUpdatedAt: string;
  requestedByUserId?: string;
  commandPlanJson: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RuntimeAppSkillBindingRecord {
  workspaceId: string;
  runtimeAppId: string;
  skillId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  createdAt: string;
}

export type McpTransport = "streamable_http" | "sse" | "managed_service" | "managed_stdio";
export type McpRisk = "low" | "medium" | "high";
export type McpCatalogSource = "official" | "verified_partner" | "workspace_private";
export type McpConnectionStatus =
  | "pending_configuration"
  | "queued_verification"
  | "verifying"
  | "ready"
  | "degraded"
  | "failed"
  | "disabled";
export type McpConnectionOperationType = "verify" | "enable" | "disable" | "remove";
export type McpConnectionOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type McpConnectionOperationStage = "queued" | "connecting" | "negotiating" | "discovering_tools" | "finalizing" | "completed";
export type McpConnectionOperationSource = "user_verify" | "config_change" | "secret_rotation" | "health_check" | "enable" | "remove";
export type McpToolCallOutcome = "succeeded" | "failed";
export type McpCatalogCategory =
  | "developer_tools"
  | "productivity"
  | "data_analytics"
  | "communication"
  | "knowledge"
  | "automation"
  | "other";
export type McpErrorCode =
  | "mcp.policy_denied"
  | "mcp.network_unreachable"
  | "mcp.authentication_failed"
  | "mcp.protocol_invalid"
  | "mcp.timeout"
  | "mcp.tool_not_approved"
  | "mcp.approved_tool_missing";

export interface McpCatalogItemRecord {
  id: string;
  workspaceId: string;
  source: McpCatalogSource;
  slug: string;
  version: string;
  category: McpCatalogCategory;
  transport: McpTransport;
  displayName: string;
  description: string;
  allowedHostsJson: string;
  configurationSchemaJson: string;
  declaredToolsJson: string;
  defaultApprovedToolsJson: string;
  secretFieldsJson: string;
  requiredRuntimeCapabilitiesJson: string;
  dataDomainsJson: string;
  risk: McpRisk;
  endpointTemplate?: string;
  documentationUrl?: string;
  requiredRuntimeApp?: {
    source: RuntimeAppCatalogSource;
    name: string;
    version: string;
  };
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeMcpConnectionRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  catalogItemId: string;
  status: McpConnectionStatus;
  approvedToolsJson: string;
  endpoint: string;
  nonSecretParamsJson: string;
  endpointFingerprint?: string;
  lastVerifiedAt?: string;
  nextHealthCheckAt?: string;
  healthCheckConsecutiveFailures: number;
  lastStatus?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeMcpSecretRecord {
  connectionId: string;
  fieldName: string;
  encryptedValue: string;
  keyVersion: string;
  rotatedAt: string;
  rotatedByUserId?: string;
}

export interface RuntimeMcpDiscoverySnapshotRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  protocolVersion?: string;
  toolsMetadataJson: string;
  toolsFingerprint: string;
  discoveredAt: string;
  verificationLatencyMs?: number;
}

export interface RuntimeMcpOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  connectionId: string;
  operation: McpConnectionOperationType;
  source: McpConnectionOperationSource;
  status: McpConnectionOperationStatus;
  stage: McpConnectionOperationStage;
  failedStage?: McpConnectionOperationStage;
  stageUpdatedAt: string;
  requestSnapshotJson: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedByUserId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RuntimeMcpToolAuditRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  taskId?: string;
  toolName: string;
  outcome: McpToolCallOutcome;
  latencyMs?: number;
  safeSummary?: string;
  /** Client-generated idempotency key (unique per workspace). */
  eventId?: string;
  /** Immutable execution identity copied from the authenticated task. */
  actorType?: "agent";
  actorId?: string;
  runtimeId?: string;
  createdAt: string;
}

export interface StoredSkillRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  sourceType: string;
  sourceUrl?: string;
  configJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillFileRecord {
  id: string;
  skillId: string;
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAgentSkillRecord {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  skillArtifactDigest?: string;
  /** Rollout revision pin (e.g. "v1") that fixes new tasks to a specific installation revision until the rollout switches. */
  rolloutPin?: string;
  createdAt: string;
}

export interface StoredAgentSkillRequirementConfigRecord {
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  configJson: string;
  encryptedSecretsJson: string;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredKnowledgeAssignmentPolicyRecord {
  workspaceId: string;
  knowledgePageId: string;
  assignmentMode: KnowledgeAssignmentMode;
  updatedAt: string;
  updatedBy: string;
}

export interface StoredAgentKnowledgePageRecord {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  knowledgePageId: string;
  createdAt: string;
  createdBy: string;
}

export interface StoredSkillImportEventRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  skillName: string;
  sourceType: string;
  sourceUrl?: string;
  importMode: "created" | "renamed" | "replaced";
  metadataJson: string;
  importedAt: string;
}

export type ChannelParticipantStatus = "active" | "removed";

export interface StoredChannelParticipantRecord {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: ChannelParticipantStatus;
  addedBy?: string;
  joinedAt: string;
  removedAt?: string;
  updatedAt: string;
}

export type ChannelAccessRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface StoredChannelAccessRequestRecord {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: ChannelAccessRequestStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export type ChannelInvitationStatus = "pending" | "accepted" | "rejected" | "revoked" | "expired";

export interface StoredChannelInvitationRecord {
  id: string;
  workspaceId: string;
  channelName: string;
  inviteeUserId?: string;
  inviteeEmail?: string;
  invitedBy: string;
  status: ChannelInvitationStatus;
  createdAt: string;
  expiresAt?: string;
  respondedAt?: string;
  respondedBy?: string;
}

export type NativeTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "preparing_commit"
  | "committed"
  | "completed"
  | "failed"
  | "cancelled";
export const TASK_EXECUTION_EVENT_TYPES = [
  "queued",
  "assigned",
  "workspace_prepared",
  "context_loaded",
  "tool_started",
  "tool_finished",
  "artifact_detected",
  "artifact_collected",
  "approval_requested",
  "approval_reviewed",
  "blocked",
  "handoff_created",
  "message_posted",
  "commit_preparing",
  "commit_committed",
  "commit_failed",
  "recovery_started",
  "recovery_completed",
  "recovery_failed",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskExecutionEventType = typeof TASK_EXECUTION_EVENT_TYPES[number];
export type TaskExecutionEventSeverity = "info" | "warning" | "error";
export type TaskExecutionEventStatus = "pending" | "running" | "succeeded" | "failed";

export interface QueuedTaskRecord {
  id: string;
  workspaceId: string;
  /** Stable employee identity used for authorization, attribution and fencing. */
  employeeId: string;
  /** Display-name snapshot captured when the task was queued. */
  employeeName: string;
  /** @deprecated Legacy display-name field. Use employeeId for identity. */
  agentId: string;
  runtimeId: string;
  /** Runtime credential captured when the task is claimed; immutable for billing attribution. */
  runtimeCredentialId?: string;
  routerSessionId?: string;
  issueId?: string;
  triggerType: string;
  priority: number;
  status: NativeTaskStatus;
  inputJson: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  resultJson?: string;
  errorText?: string;
  sessionId?: string;
  workDir?: string;
  bindingGeneration?: number;
  queuedAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  mcpSessionClaimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessageRecord {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  tool?: string;
  content?: string;
  inputJson?: string;
  output?: string;
  /** Correlates a tool_result with its tool_use (provider-side call id). */
  refId?: string;
  createdAt: string;
}

export interface TaskExecutionEventRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  channelName: string;
  agentId: string;
  runtimeId?: string;
  runId?: string;
  type: TaskExecutionEventType;
  title: string;
  summary?: string;
  severity: TaskExecutionEventSeverity;
  status?: TaskExecutionEventStatus;
  dataJson: string;
  createdAt: string;
}

export interface EnqueueTaskInput {
  workspaceId?: string;
  taskId?: string;
  assignee: string;
  title: string;
  channel?: string;
  priority: "low" | "medium" | "high";
  triggerType?: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  metadata?: Record<string, unknown>;
}

export function isNativeTaskStatus(value: unknown): value is NativeTaskStatus {
  return (
    value === "queued" ||
    value === "claimed" ||
    value === "running" ||
    value === "preparing_commit" ||
    value === "committed" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export function isTaskExecutionEventType(value: unknown): value is TaskExecutionEventType {
  return typeof value === "string" && TASK_EXECUTION_EVENT_TYPES.includes(value as TaskExecutionEventType);
}

export function isTaskExecutionEventSeverity(value: unknown): value is TaskExecutionEventSeverity {
  return value === "info" || value === "warning" || value === "error";
}

export function isTaskExecutionEventStatus(value: unknown): value is TaskExecutionEventStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed";
}

export interface ModelPricingRecord {
  modelId: string;
  displayName: string;
  inputPer1M: number;
  outputPer1M: number;
  currency: string;
  updatedAt: string;
}

export type TokenUsageBillingStatus = "estimated" | "pending_reconciliation" | "reconciled" | "unallocated" | "voided";

export interface TokenUsageRecord {
  id: string;
  workspaceId: string;
  taskQueueId?: string;
  agentId: string;
  modelId: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  gatewayUsageId?: string;
  protocol?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  billingStatus?: TokenUsageBillingStatus;
  gatewayRequestId?: string;
  delegationId?: string;
  employeeId?: string;
  runtimeId?: string;
  jobId?: string;
  pipelineStage?: string;
  sourceInvocationId?: string;
  modelInvocationId?: string;
  actualCostUsd?: number;
  currency?: string;
  reconciledAt?: string;
  requestStartedAt?: string;
  requestEndedAt?: string;
  sourceUpdatedAt?: string;
  channelName?: string;
  createdAt: string;
}

export type BudgetScope = "workspace" | "agent" | "channel";
export type BudgetPeriod = "monthly" | "total";
export type BudgetAction = "pause" | "approve" | "warn";

export interface BudgetRecord {
  id: string;
  workspaceId: string;
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
  action: BudgetAction;
  warningThreshold: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function priorityToNumber(priority: EnqueueTaskInput["priority"]): number {
  if (priority === "high") {
    return 3;
  }
  if (priority === "medium") {
    return 2;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Employee data durability (EAD-001 .. EAD-005)                      */
/* ------------------------------------------------------------------ */

export interface ContentBlobRecord {
  sha256: string;
  workspaceId: string;
  storageProvider: string;
  storageBucket?: string;
  storageRegion?: string;
  storageEndpoint?: string;
  storageKey: string;
  sizeBytes: number;
  mediaType: string;
  createdAt: string;
}

export type SkillArtifactSource =
  | "manual"
  | "github"
  | "skills.sh"
  | "clawhub"
  | "local"
  | "tos"
  | "legacy";

export interface SkillArtifactRecord {
  id: string;
  workspaceId: string;
  digest: string;
  skillId?: string;
  name: string;
  version: string;
  manifestVersion: number;
  manifestJson: string;
  sourceType: string;
  sourceUrl?: string;
  provenanceJson: string;
  fileCount: number;
  totalSizeBytes: number;
  legacyIncomplete: boolean;
  createdAt: string;
}

export interface SkillArtifactFileRecord {
  id: string;
  artifactId: string;
  workspaceId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  mode: string;
  isText: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Skill installations (artifact × runtime preparation)                */
/* ------------------------------------------------------------------ */

export type SkillInstallationComponentKind = "dependency" | "script" | "cli" | "mcp" | "service";
export type SkillInstallationComponentStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "blocked"
  | "failed"
  | "degraded";
export type SkillInstallationOperationStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type SkillInstallationOperationType =
  | "inspect"
  | "prepare"
  | "verify"
  | "activate"
  | "deactivate"
  | "uninstall"
  | "upgrade"
  | "rollback";

export interface StoredSkillInstallationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  artifactDigest: string;
  status: string;
  resolvedLockJson: string;
  preparedPath?: string;
  preparedDigest?: string;
  health: string;
  previousReadyRevision?: string;
  previousReadyArtifactDigest?: string;
  revision: string;
  installedAt?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillInstallationComponentRecord {
  id: string;
  installationId: string;
  kind: SkillInstallationComponentKind;
  key: string;
  status: SkillInstallationComponentStatus;
  errorCode?: string;
  errorMessage?: string;
  lastOperationId?: string;
  verifiedAt?: string;
  updatedAt: string;
}

export interface PagerAlertStateRecord {
  id: string;
  workspaceId: string;
  alertKey: string;
  code: string;
  employeeName?: string;
  metric?: string;
  severity: string;
  status: "active" | "cleared";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  lastEscalatedAt?: string;
  clearedAt?: string;
}

export interface WorkspaceGitCredentialRecord {
  id: string;
  workspaceId: string;
  host: string;
  credentialType: "token" | "ssh_key";
  referenceName: string;
  /** Encrypted at rest; never returned to the UI. */
  encryptedSecret: string;
  /** sha256 hex of the plaintext — rotation/leak detection, non-secret. */
  fingerprint: string;
  status: "active" | "revoked";
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface SkillRunnerInvocationRecord {
  id: string;
  workspaceId: string;
  taskId?: string;
  runtimeId?: string;
  installationId?: string;
  skillId?: string;
  skillName: string;
  artifactDigest: string;
  revision?: string;
  entrypointId: string;
  entrypointKey: string;
  entrypointPath?: string;
  entrypointRuntime?: string;
  actorId: string;
  actorType: string;
  resultCode: number;
  timedOut: boolean;
  durationMs?: number;
  safeSummary?: string;
  eventId?: string;
  createdAt: string;
}

export interface SkillInstallApprovalRiskItem {
  category: "script" | "network" | "mcp_tool" | "write";
  key: string;
  description: string;
}

export interface SkillInstallApprovalRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  policyVersion: string;
  riskDecisionDigest: string;
  decision: "approved" | "rejected";
  riskItems: SkillInstallApprovalRiskItem[];
  reason?: string;
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface SkillUpgradeApprovalRecord {
  id: string;
  workspaceId: string;
  skillId?: string;
  fromDigest: string;
  toDigest: string;
  diffHash: string;
  policyVersion: string;
  decision: "approved" | "rejected";
  reason?: string;
  actorUserId?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface StoredSkillInstallationOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  installationId: string;
  operation: SkillInstallationOperationType;
  status: SkillInstallationOperationStatus;
  requestSnapshotJson: string;
  safeResultJson: string;
  errorCode?: string;
  /** Lease expiry while claimed/running; null once completed/failed/pending. */
  leaseExpiresAt?: string;
  /** Monotonic fencing value incremented on every claim. */
  claimGeneration: number;
  errorMessage?: string;
  claimedAt?: string;
  completedAt?: string;
  requestedByUserId?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Skill support services (catalog + managed instance + binding)       */
/* ------------------------------------------------------------------ */

export interface StoredSkillServiceCatalogRecord {
  id: string;
  workspaceId: string;
  slug: string;
  templateVersion: string;
  deploymentType: string;
  imageDigest: string;
  protocol: string;
  scope: string;
  resourcesJson: string;
  healthJson: string;
  networkJson: string;
  configSchemaVersion: number;
  configSchemaJson: string;
  secretFieldsJson: string;
  externalDependenciesJson: string;
  rollbackClass: string;
  templateDigest: string;
  sbomDigest?: string;
  runAsNonRoot: boolean;
  readOnlyRootfs: boolean;
  capDropJson: string;
  /** Cosign public key (PEM) trusted to sign this template's image, when enforced. */
  signatureKeyPem?: string;
  /** When true the managed node MUST verify the image signature before pulling. */
  signatureRequired: boolean;
  risk: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredManagedSkillServiceRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  catalogId: string;
  status: string;
  networkIdentity?: string;
  resourceProfileJson: string;
  lastHealth?: string;
  lastHealthAt?: string;
  rolloutRevision: string;
  /** Set by the retire sweep when the service first became unreferenced (rollback-cooldown window). */
  unreferencedSince?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillServiceBindingRecord {
  installationId: string;
  serviceId: string;
  catalogTemplateVersion: string;
  serviceImageDigest: string;
  endpointRef: string;
  healthRevision: string;
  configSchemaVersion: number;
  createdAt: string;
}

export interface ManagedSkillServiceOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  serviceId: string;
  installationId?: string;
  /** For a canary provision: the green managed service this instance replaces
   *  (the control plane switches bindings away from it on completion). */
  replacesServiceId?: string;
  operation: "provision" | "retire";
  status: "pending" | "claimed" | "running" | "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
  claimedAt?: string;
  completedAt?: string;
  leaseExpiresAt?: string;
  /** Monotonic fencing value incremented on every claim. */
  claimGeneration: number;
  createdAt: string;
}

export interface StoredWorkspaceServiceSecretRecord {
  id: string;
  workspaceId: string;
  serviceCatalogId: string;
  name: string;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
}

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
