// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/workspace` 子路径与根 re-export 使用。

export {
  getWorkspaceStateFilePath,
  getWorkspaceDatabaseFilePath,
  ensureWorkspaceStateSync,
  readWorkspaceStateSnapshotSync,
  readWorkspaceStateSync,
  mutateWorkspaceStateSync,
  writeWorkspaceStateSync,
  resetWorkspaceStateSync,
} from "../shared/state-io.ts";

export {
  recordPlatformAuditEventSync,
  recordPlatformAuditEventAsync,
  PLATFORM_AUDIT_WORKSPACE_ID,
  recordWorkspaceAuditEventSync,
  tryRecordPlatformAuditEventSync,
  tryRecordPlatformAuditEventAsync,
  tryRecordWorkspaceAuditEventSync,
} from "../shared/audit.ts";

export {
  archiveNotificationAsync,
  archiveNotificationSync,
  countUnreadNotificationsSync,
  createNotificationSync,
  createNotificationsSync,
  listNotificationsForRecipientSync,
  listNotificationsForRecipientAsync,
  markNotificationReadAsync,
  markNotificationReadSync,
  notifyWorkspaceAdminsAsync,
  notifyWorkspaceAdminsSync,
  postNotificationChannelMessageSync,
  type CreateWorkspaceNotificationInput,
  type WorkspaceNotificationRecipient,
  type WorkspaceNotificationRecipientType,
  type WorkspaceNotificationRecord,
  type WorkspaceNotificationResourceType,
  type WorkspaceNotificationSeverity,
  type WorkspaceNotificationStatus,
} from "../notifications/notifications.ts";

export {
  buildConversationExecutionWorkspaceKey,
  readConversationExecutionWorkspaceState,
  resolveConversationExecutionWorkspacePath,
  upsertConversationExecutionWorkspaceState,
  writeConversationExecutionWorkspaceStateSync,
} from "../shared/conversation-execution-workspaces.ts";

export {
  bootstrapWorkspaceSync,
  initializeOrganizationSync,
  addHumanMemberSync,
  readWorkspaceSnapshotSync,
  readWorkspaceSummarySync,
} from "./workspace.ts";

export { listWorkspaceMembershipsAsync } from "../workspace-memberships.ts";

export {
  resolveAttachmentMediaType,
  inferAttachmentKind,
  sameValue,
} from "../shared/helpers.ts";
