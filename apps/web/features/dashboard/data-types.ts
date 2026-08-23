// Workspace dashboard 页面的共享视图模型类型定义。
// 从 ./data.ts（原 5.7k 行）拆出：类型层无运行时依赖，可被 ./dashboard-view-builders.ts
// 与各域 loader 单向引用。./data.ts 通过 `export *` 对外保持原有导入路径不变。
import type { AgentSkillRequirementSummary } from "@dofe-agent/services/skills";
import type { FeishuChatMemberSnapshot } from "@dofe-agent/services/integrations";
import type { WorkspaceNotificationRecord } from "@dofe-agent/services/workspace";
import type {
  TaskExecutionEventType,
  TaskMessageRecord,
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelDocument,
  ChannelDocumentVersion,
  KnowledgeAssignmentMode,
  KnowledgePage,
  LedgerItem,
  MessageAttachment,
  TaskRecord,
  WorkspaceMessage,
  WorkspaceSkill,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocumentAccessRole,
  ChannelDocumentChangeSet,
  ChannelDocumentConflict,
  ChannelDocumentPresence,
  ChannelDocumentRun,
  ChannelDocumentRunStep,
  RuntimeProviderHealth,
} from "@dofe-agent/domain";
import type { DaemonProvider } from "@dofe-agent/domain";
import type {
  FeishuAgentBotSetupReference,
  FeishuIntegrationSettingsItem,
} from "@/features/integrations/feishu/feishu-types";

export type InboxItemKind = "notification" | "task" | "channel" | "activity";

export interface InboxTimelineEntry {
  id: string;
  role: "human" | "agent" | "assistant" | "user" | "system";
  actor: string;
  timestamp: string;
  body: string;
  attachments?: MessageAttachment[];
  status?: "completed" | "error";
}

export type TaskExecutionTimelineCategory = "status" | "tool" | "artifact" | "approval" | "error" | "handoff";
export type TaskExecutionTimelineAction = "retry" | "grant_permission" | "handoff" | "mark_blocked" | "rollback";

export interface TaskExecutionTimelineEntry {
  id: string;
  type: TaskExecutionEventType;
  category: TaskExecutionTimelineCategory;
  title: string;
  summary?: string;
  severity: "info" | "warning" | "error";
  status?: "pending" | "running" | "succeeded" | "failed";
  createdAt: string;
  targetHref?: string;
  nextActions?: TaskExecutionTimelineAction[];
}

export interface RouterExecutionAttemptView {
  id: string;
  runtimeId: string;
  provider: string;
  providerSessionId?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  errorText?: string;
  handoffSnapshotId?: string;
  routingMode?: string;
  fallbackReason?: string;
}

export interface RouterProviderSessionView {
  id: string;
  runtimeId: string;
  provider: string;
  providerSessionId: string;
  status: string;
  lastUsedAt?: string;
  lastError?: string;
}

export interface RouterExecutionView {
  routerSessionId: string;
  conversationKey?: string;
  sourceType?: string;
  continuationMode: "same_provider_resume" | "cold_rebuild" | "fallback";
  attempts: RouterExecutionAttemptView[];
  providerSessions: RouterProviderSessionView[];
}

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  title: string;
  subtitle: string;
  meta: string;
  channelKind?: "group" | "direct";
  timestamp: string;
  unread: boolean;
  statusLabel: string;
  statusTone: "neutral" | "positive" | "warning" | "danger";
  body: string;
  actionHref?: string;
  attachments?: MessageAttachment[];
  history: InboxTimelineEntry[];
  notification?: WorkspaceNotificationRecord;
  task?: TaskRecord;
  channelName?: string;
  activity?: LedgerItem;
  execution?: {
    queueId: string;
    queueStatus: string;
    runtimeId: string;
    runtimeName?: string;
    provider?: string;
    daemonMode?: "local" | "remote";
    serverUrl?: string;
    sessionId?: string;
    router?: RouterExecutionView;
    workDir?: string;
    workDirAccess?: "local" | "remote";
    workDirHostLabel?: string;
    errorText?: string;
    messageCount: number;
    /** Lossless provider/runtime stream. The lifecycle timeline below is a normalized summary. */
    runtimeTrace: TaskMessageRecord[];
    currentEvent?: TaskExecutionTimelineEntry;
    timeline: TaskExecutionTimelineEntry[];
  };
}

export interface InboxPageData {
  items: InboxItem[];
  totalCount: number;
  unreadCount: number;
  notificationCount: number;
  taskCount: number;
  channelCount: number;
  activityCount: number;
}

export interface DashboardCurrentUser {
  id: string;
  displayName?: string;
  role?: WorkspaceRole;
}

export interface ContactListItem {
  id: string;
  name: string;
  subtitle: string;
  summary: string;
  lastMessage?: string;
  updatedAt?: string;
  channelName?: string;
}

export interface ChannelListItem {
  id: string;
  name: string;
  channelName?: string;
  contactId?: string;
  agentEmployeeId?: string;
  humanContactUserId?: string;
  memberLabel: string;
  humanMemberNames?: string[];
  employeeNames?: string[];
  lastMessage?: string;
  updatedAt?: string;
  kind?: "group" | "direct";
  directParticipantKind?: "agent" | "human";
  displayName?: string;
  displaySubtitle?: string;
  avatarLabel?: string;
  memberCount?: number;
  unread?: boolean;
  canManage?: boolean;
  accessState?: "accessible" | "pending" | "requestable";
  accessRequestId?: string;
  feishu?: ChannelFeishuSummaryRecord;
}

export interface ChannelFeishuSummaryRecord {
  bindingCount: number;
  externalChatReference?: string;
  externalChatName?: string;
  externalChatType?: string;
  provisionSource?: string;
  reviewStatus?: string;
  liveMembers?: FeishuChatMemberSnapshot;
  connectedAgentBots: Array<{
    integrationId: string;
    displayName: string;
    agentId: string;
    status: string;
    unboundUserMode?: string;
    guestPermissionProfile?: string;
  }>;
  resourceBindings: Array<{
    id: string;
    integrationId: string;
    integrationDisplayName: string;
    providerResourceType: string;
    displayName?: string;
    canWrite: boolean;
    guestReadable: boolean;
    status: string;
  }>;
}

export interface ChannelThreadData {
  channelName: string;
  messages: WorkspaceMessage[];
  /** Structured execution stream (task_message rows) keyed by source task id, for the execution timeline view. */
  taskExecutions?: Record<string, TaskMessageRecord[]>;
}

export interface ChannelsPageData {
  workspaceId: string;
  channels: ChannelListItem[];
  threads: ChannelThreadData[];
  documents: ChannelDocumentRecord[];
  documentRuns: ChannelDocumentRunRecord[];
  documentConflicts: ChannelDocumentConflictRecord[];
  channelFiles: ChannelFileRecord[];
  mentionCandidates: Array<{
    id: string;
    label: string;
    subtitle: string;
    channels: string[];
    kind?: "agent" | "human";
  }>;
  channelMemberCandidates?: Array<{
    id: string;
    label: string;
    kind: "human" | "agent";
    meta: string;
    email?: string;
  }>;
  composerAgents?: Array<{
    id: string;
    label: string;
    provider?: DaemonProvider;
    executionPolicy?: import("@dofe-agent/domain/workspace").EmployeeExecutionPolicy;
    skills: Array<{
      id: string;
      name: string;
      description: string;
    }>;
  }>;
  composerSkills?: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  totalChannels: number;
  detailScope?: string[];
}

export type ChannelDetailPageData = Pick<
  ChannelsPageData,
  "channelFiles" | "detailScope" | "documentConflicts" | "documentRuns" | "documents" | "threads"
>;

export interface ChannelDocumentVersionRecord {
  id: string;
  contentMarkdown: string;
  summary: string;
  createdAt: string;
  createdBy: string;
  createdByType: ChannelDocumentVersion["createdByType"];
  triggerType: ChannelDocumentVersion["triggerType"];
  sourceMessageId?: string;
  sourceAttachmentId?: string;
  sourceAttachmentStoredPath?: string;
}

export interface ChannelDocumentChangeSetRecord {
  id: string;
  documentId: string;
  actorId: string;
  actorType: ChannelDocumentChangeSet["actorType"];
  baseVersionId: string;
  documentVersionId?: string;
  status: ChannelDocumentChangeSet["status"];
  sourceMessageId?: string;
  sourceTaskQueueId?: string;
  createdAt: string;
  operationSummary: string;
  retryable: boolean;
  sourceMessage?: {
    id: string;
    speaker: string;
    summary: string;
    time: string;
  };
  sourceTask?: {
    id: string;
    title: string;
    status: string;
  };
  sourceStep?: {
    id: string;
    runId: string;
    agentLabel: string;
    instruction: string;
    status: ChannelDocumentRunStep["status"];
  };
}

export interface ChannelDocumentPresenceRecord {
  actorId: string;
  actorType: ChannelDocumentPresence["actorType"];
  status: ChannelDocumentPresence["status"];
  updatedAt: string;
  isCurrentUser: boolean;
}

export interface ChannelDocumentAccessRecord {
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
  isCurrentUser: boolean;
}

export interface ChannelDocumentCollaboratorCandidateRecord {
  actorId: string;
  actorType: "human" | "agent";
  label: string;
  subtitle: string;
}

export interface ChannelDocumentSyncEventRecord {
  actorId: string;
  actorType: ChannelDocumentVersion["createdByType"];
  triggerType: ChannelDocumentVersion["triggerType"];
  versionId: string;
  createdAt: string;
  isRecent: boolean;
  sourceMessage?: {
    id: string;
    speaker: string;
    summary: string;
    time: string;
  };
  sourceTask?: {
    id: string;
    title: string;
    status: string;
  };
  sourceStep?: {
    id: string;
    runId: string;
    agentLabel: string;
    instruction: string;
    status: ChannelDocumentRunStep["status"];
  };
}

export interface ChannelDocumentRecord {
  id: string;
  channelName: string;
  title: string;
  slug: string;
  kind: ChannelDocument["kind"];
  storageMode: NonNullable<ChannelDocument["storageMode"]>;
  currentVersionId: string;
  summary: string;
  status: ChannelDocument["status"];
  updatedAt: string;
  updatedBy: string;
  lastEditorType: ChannelDocument["lastEditorType"];
  contentMarkdown: string;
  versionCount: number;
  conflictCount: number;
  versions: ChannelDocumentVersionRecord[];
  changeSets: ChannelDocumentChangeSetRecord[];
  activePresences: ChannelDocumentPresenceRecord[];
  currentUserRole: ChannelDocumentAccessRole;
  collaborators: ChannelDocumentAccessRecord[];
  availableCollaborators: ChannelDocumentCollaboratorCandidateRecord[];
  lastBackgroundSync?: ChannelDocumentSyncEventRecord;
}

export interface ChannelDocumentRunRecord {
  id: string;
  channelName: string;
  sourceMessageId: string;
  sourceSummary: string;
  mode: ChannelDocumentRun["mode"];
  status: ChannelDocumentRun["status"];
  createdAt: string;
  updatedAt: string;
  steps: Array<{
    id: string;
    agentId: string;
    agentLabel: string;
    instruction: string;
    status: ChannelDocumentRunStep["status"];
    handoffKind: ChannelDocumentRunStep["handoffKind"];
    documentId?: string;
    documentVersionId?: string;
    lastError?: string;
    lastWarning?: string;
  }>;
}

export interface ChannelDocumentConflictRecord {
  id: string;
  documentId: string;
  documentTitle: string;
  blockId: string;
  status: ChannelDocumentConflict["status"];
  createdAt: string;
  leftChangeSet?: ChannelDocumentChangeSetRecord;
  rightChangeSet?: ChannelDocumentChangeSetRecord;
  mergePreview?: {
    mode: "document" | "block";
    currentLabel: string;
    currentContentMarkdown: string;
    incomingLabel: string;
    incomingContentMarkdown: string;
    suggestedDraftContentMarkdown: string;
    suggestedDraftTitle?: string;
    suggestedDraftSummary?: string;
  };
}

export interface ChannelFileRecord {
  id: string;
  channelName: string;
  fileName: string;
  sourceMessageId?: string;
  sourceSpeaker?: string;
  sourceTime?: string;
  uploaderUserId?: string;
  uploaderDisplayName?: string;
  previewText?: string;
  mediaType: string;
  sizeBytes: number;
  kind: MessageAttachment["kind"];
  isMarkdown: boolean;
  canDelete: boolean;
  deleteBlockedReason?: string;
  retainedBecauseReferenced: boolean;
}

export type WorkspaceAgentStatus = "online" | "busy" | "blocked" | "linked" | "error";

export interface ManagementRecordBase {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  status: WorkspaceAgentStatus;
  statusLabel: string;
  tags: string[];
}

export interface AgentWorkAreaRecord {
  id: string;
  queueId: string;
  title: string;
  channel?: string;
  queueStatus: string;
  taskStatus?: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  router?: RouterExecutionView;
  workDir?: string;
  workDirAccess?: "local" | "remote";
  workDirHostLabel?: string;
  errorText?: string;
}

export interface WorkspaceAgentDocumentAccessRecord {
  id: string;
  documentId: string;
  documentTitle: string;
  channelName: string;
  role: "viewer" | "editor" | "forwarder";
  source: "explicit_grant";
  storageMode: "native" | "external";
  externalProvider?: string;
  externalFileId?: string;
  externalUrl?: string;
  updatedAt: string;
}

export interface WorkspaceAgentDocumentPermissionRequestRecord {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedRole: "viewer" | "editor" | "forwarder";
  targetLabel: string;
  documentId?: string;
  documentTitle?: string;
  externalProvider?: string;
  externalFileId?: string;
  externalUrl?: string;
  requestedForChannelName?: string;
  reason: string;
  decisionNote?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface WorkspaceAgentDocumentAccessSummaryRecord {
  readableCount: number;
  editableCount: number;
  forwardableCount: number;
  externalCount: number;
  pendingRequestCount: number;
  rejectedRequestCount: number;
  grants: WorkspaceAgentDocumentAccessRecord[];
  requests: WorkspaceAgentDocumentPermissionRequestRecord[];
}

export interface WorkspaceAgentForkInvitationView {
  id: string;
  sourceAgentName: string;
  sourceAgentDisplayName: string;
  targetUserId: string;
  targetDisplayName?: string;
  createdByUserId: string;
  createdByDisplayName?: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  updatedAt: string;
  acceptedAgentName?: string;
  acceptedRuntimeId?: string;
  contextNote?: string;
  copyProfile: boolean;
  copyInstructions: boolean;
  copySkills: boolean;
  copyKnowledgeAssignments: boolean;
  copiedSkillCount: number;
  copiedKnowledgePageCount: number;
  suggestedAgentName: string;
}

export interface WorkspaceAgentAccessRequestView {
  id: string;
  sourceAgentName: string;
  requesterUserId: string;
  requesterDisplayName?: string;
  requestType: "fork_copy" | "channel_use";
  targetChannelName?: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string;
  resolverUserId?: string;
  resolverDisplayName?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  forkInvitationId?: string;
  canDecide: boolean;
}

export interface DigitalEmployeeShowcaseAgentRecord extends ManagementRecordBase {
  kind: "digital_employee_showcase_agent";
  internalName: string;
  role: string;
  summary: string;
  fit: string;
  traits: string[];
  ownerUserId?: string;
  ownerDisplayName?: string;
  managedByLabel: string;
  canManage: boolean;
  isOwnedByCurrentUser: boolean;
  channelMemberAccess: "enabled" | "disabled";
  channels: string[];
  commonChannels: string[];
  skillCount: number;
  knowledgeCount: number;
  skillHighlights: Array<{
    name: string;
    summary?: string;
  }>;
  knowledgeHighlights: Array<{
    title: string;
    source: "direct" | "inherited";
  }>;
  readiness: {
    status: "ready" | "needs_runtime" | "runtime_offline" | "provider_unusable" | "unknown";
    label: string;
    reason?: string;
  };
  usageHints: string[];
  lastActivityAt?: string;
  requestableActions: Array<"fork_copy" | "channel_use">;
  forkedFrom?: {
    sourceAgentName: string;
    invitationId: string;
  };
  pendingRequest?: WorkspaceAgentAccessRequestView;
  latestRequest?: WorkspaceAgentAccessRequestView;
  pendingForkInvitation?: WorkspaceAgentForkInvitationView;
  reviewableRequests: WorkspaceAgentAccessRequestView[];
}

export interface WorkspaceAgentRecord extends ManagementRecordBase {
  kind: "agent";
  employeeId: string;
  internalName: string;
  ownerUserId?: string;
  ownerDisplayName?: string;
  canManage: boolean;
  canManageChannelMemberAccess: boolean;
  channelMemberAccess: "enabled" | "disabled";
  origin: string;
  fit: string;
  summary: string;
  skills: WorkspaceSkill[];
  skillRequirements: Record<string, AgentSkillRequirementSummary>;
  channels: string[];
  tasks: TaskRecord[];
  recentMessages: WorkspaceMessage[];
  boundContainerId?: string;
  boundContainerName?: string;
  boundContainerStatus?: "online" | "offline";
  boundProvider?: string;
  boundProviderHealth?: RuntimeProviderHealth;
  boundAt?: string;
  runtimeCapabilities?: {
    cliApps: RuntimeInstalledAppView[];
    mcpServices: RuntimeMcpConnectionView[];
  };
  defaultModel?: string;
  executionPolicy?: import("@dofe-agent/domain/workspace").EmployeeExecutionPolicy;
  workAreas: AgentWorkAreaRecord[];
  instructions?: string;
  knowledge?: WorkspaceAgentKnowledgeRecord;
  feishuAgentBot?: FeishuIntegrationSettingsItem;
  feishuAgentBotSetupReference?: FeishuAgentBotSetupReference;
  canManageFeishuAgentBot?: boolean;
  documentAccess?: WorkspaceAgentDocumentAccessSummaryRecord;
  forkedFrom?: {
    sourceAgentName: string;
    invitationId: string;
  };
  forkInvitations?: WorkspaceAgentForkInvitationView[];
}

export interface KnowledgeAgentOption {
  id: string;
  employeeName: string;
  name: string;
  subtitle: string;
  status: WorkspaceAgentStatus;
}

export interface KnowledgeAssignedAgentRecord extends KnowledgeAgentOption {
  assignedAt?: string;
  assignedBy?: string;
}

export interface KnowledgePageRecord extends KnowledgePage {
  assignmentMode: KnowledgeAssignmentMode;
  assignmentUpdatedAt?: string;
  assignmentUpdatedBy?: string;
  assignedAgents: KnowledgeAssignedAgentRecord[];
  assignedAgentIds: string[];
  assignedEmployeeNames: string[];
  assignedAgentCount: number;
  effectiveAgentCount: number;
  assignmentSummary: string;
}

export interface KnowledgeAssignmentStats {
  allAgentsPageCount: number;
  selectedAgentsPageCount: number;
  unconfiguredPageCount: number;
}

export interface AgentKnowledgePageRecord {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string;
  assignmentMode: KnowledgeAssignmentMode;
  sourceLabel?: string;
}

export interface WorkspaceAgentKnowledgeRecord {
  directPageIds: string[];
  inheritedPages: AgentKnowledgePageRecord[];
  directPages: AgentKnowledgePageRecord[];
  assignablePages: AgentKnowledgePageRecord[];
  totalAvailableCount: number;
  directCount: number;
  inheritedCount: number;
}

export interface ContainerRecord extends ManagementRecordBase {
  kind: "container";
  runtimeId: string;
  provider: string;
  displayName?: string;
  daemonKey: string;
  deviceName: string;
  runtimeStatus: "online" | "offline";
  providerHealth: RuntimeProviderHealth;
  daemonMode?: "local" | "remote";
  serverUrl?: string;
  version?: string;
  lastHeartbeatAt?: string;
  executablePath?: string;
  daemonPid?: string;
  cliHubReadiness?: CliHubReadinessRecord;
  installedApps: RuntimeInstalledAppView[];
  mcpConnections?: RuntimeMcpConnectionView[];
  recentAppOperations: RuntimeAppOperationView[];
  grantedMembers: RuntimeGrantMember[];
  canManageGrants: boolean;
  boundEmployees: string[];
  agentCount: number;
  queueCounts: {
    queued: number;
    running: number;
    failed: number;
    completed: number;
  };
  recentExecutions: Array<{
    queueId: string;
    taskId?: string;
    title: string;
    assignee: string;
    channel?: string;
    queueStatus: string;
    taskStatus?: string;
    messageCount: number;
    startedAt?: string;
    finishedAt?: string;
    sessionId?: string;
    router?: RouterExecutionView;
    workDir?: string;
    workDirAccess?: "local" | "remote";
    workDirHostLabel?: string;
    errorText?: string;
    taskMessages: Array<{
      id: string;
      type: string;
      content: string;
      createdAt: string;
      status: "completed" | "error";
    }>;
    timeline: TaskExecutionTimelineEntry[];
  }>;
}

export interface CliHubReadinessRecord {
  checkedAt?: string;
  python: ReadinessItemView;
  pip: ReadinessItemView;
  cliHub: ReadinessItemView;
  npm: ReadinessItemView;
  uv: ReadinessItemView;
}

export interface RuntimeInstalledAppView {
  source: string;
  name: string;
  displayName: string;
  version: string;
  entryPoint: string;
  status: string;
  enabled: boolean;
  lastError?: string;
  updatedAt: string;
}

export interface RuntimeAppOperationView {
  id: string;
  appSource: string;
  appName: string;
  operation: string;
  status: string;
  createdAt: string;
  errorMessage?: string;
}

export interface RuntimeMcpConnectionView {
  id: string;
  catalogItemId: string;
  catalogDisplayName: string;
  transport: string;
  status: string;
  approvedToolCount: number;
  lastVerifiedAt?: string;
  updatedAt: string;
}

export interface RuntimeGrantMember {
  userId: string;
  displayName: string;
  primaryEmail?: string;
  role: WorkspaceRole;
}

export interface AgentsPageData {
  workspaceId?: string;
  containers: ContainerRecord[];
  agents: WorkspaceAgentRecord[];
  showcaseAgents: DigitalEmployeeShowcaseAgentRecord[];
  daemonSnapshots: DaemonSnapshotView[];
  daemonTokens: DaemonTokenView[];
  providerAccounts: ProviderAccountView[];
  runtimeProvisionRequests: RuntimeProvisionRequestView[];
  workspaceSkills: WorkspaceSkill[];
  channels: Array<{
    name: string;
    memberLabel: string;
  }>;
  workspaceMembers: RuntimeGrantMember[];
  pendingForkInvitations: WorkspaceAgentForkInvitationView[];
  containerOptions: Array<{
    id: string;
    label: string;
    provider: string;
    status: "online" | "offline";
    providerHealth: RuntimeProviderHealth;
    serverName: string;
    daemonKey: string;
    mode?: "local" | "remote";
    /** Present only for managed runtimes surfaced as reusable execution engines. */
    managed?: boolean;
    /** Managed-runtime lifecycle state used to explain whether it can be bound. */
    provisioningState?: "managed" | "draining" | "credential_recovering" | "needs_attention" | "legacy";
    /** False when a managed runtime must not receive new or updated bindings. */
    bindable?: boolean;
    defaultModel?: string;
    protocols?: string[];
    assignedEmployeeCount?: number;
    /** When false, this runtime refuses new employee binds. */
    allowNewEmployeeSharing?: boolean;
  }>;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
  canConnectRuntimes: boolean;
  canManageRuntimes: boolean;
  canManageAllAgents: boolean;
  canCreateAgent: boolean;
  totalAgents: number;
  containerCount: number;
  boundAgentCount: number;
  unboundAgentCount: number;
  activeTaskCount: number;
  activeWorkAreaCount: number;
}

export interface DaemonSnapshotView {
  daemonKey: string;
  deviceName: string;
  status: "online" | "offline";
  lastHeartbeatAt?: string;
  mode: "local" | "remote";
  serverUrl?: string;
  runtimeName?: string;
  runtimes: Array<{
    id: string;
    provider: string;
    providerAccountId?: string;
    providerAccountName?: string;
    name: string;
    displayName?: string;
    status: "online" | "offline";
    providerHealth: RuntimeProviderHealth;
    lastHeartbeatAt?: string;
    version: string;
  }>;
}

export interface ProviderAccountView {
  id: string;
  provider: string;
  name: string;
  billingAccountId?: string;
  allowedModels: string[];
  status: "active" | "inactive" | "legacy";
}

export interface RuntimeProvisionRequestView {
  id: string;
  provider: string;
  providerAccountId: string;
  providerAccountName: string;
  runtimeName: string;
  targetServer: string;
  status: "requested" | "approved" | "cancelled" | "fulfilled";
  createdAt: string;
}

export interface ReadinessItemView {
  available: boolean;
  version?: string;
  error?: string;
}

export interface DaemonTokenView {
  id: string;
  label: string;
  status: "active" | "revoked";
  createdBy: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface SkillsPageData {
  skills: Array<WorkspaceSkill & {
    isBuiltin: boolean;
  }>;
  totalSkills: number;
  assignedSkillCount: number;
  currentMembershipRole?: WorkspaceRole;
  recentImports: Array<{
    id: string;
    skillId?: string;
    skillName: string;
    sourceType: string;
    sourceUrl?: string;
    importMode: "created" | "renamed" | "replaced";
    importedAt: string;
    warnings: string[];
  }>;
  agents: Array<{
    id: string;
    name: string;
    internalName: string;
    skillIds: string[];
  }>;
}

export interface KnowledgeDocumentPageRecord {
  id: string;
  sourceType: "attachment" | "channelDocument";
  sourceId: string;
  title: string;
  summary: string;
  previewText: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  kind: MessageAttachment["kind"];
  isMarkdown: boolean;
  channelName?: string;
  sourceMessageId?: string;
  sourceSpeaker?: string;
  sourceTime?: string;
  updatedAt: string;
  updatedBy: string;
  status: "active" | "archived" | "shared";
  sourceAttachmentId?: string;
  linkedChannelDocuments: Array<{
    id: string;
    title: string;
    channelName: string;
  }>;
  linkedKnowledgePages: Array<{
    id: string;
    title: string;
  }>;
}
