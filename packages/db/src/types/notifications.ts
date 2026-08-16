// 工作区通知（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


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
  | "skill"
  | "capability_request";
export type WorkspaceNotificationSeverity = "info" | "success" | "warning" | "critical" | "error";
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
