import {
  archiveWorkspaceNotificationSync,
  countUnreadWorkspaceNotificationsSync,
  createWorkspaceNotificationSync,
  createWorkspaceNotificationsSync,
  listWorkspaceMemberUsersSync,
  listWorkspaceNotificationsForRecipientSync,
  markWorkspaceNotificationReadSync,
  type CreateWorkspaceNotificationInput,
  type WorkspaceNotificationRecipient,
  type WorkspaceNotificationRecord,
  type WorkspaceNotificationRecipientType,
  type WorkspaceNotificationResourceType,
  type WorkspaceNotificationSeverity,
  type WorkspaceNotificationStatus,
} from "@dofe-agent/db";
import { postMessageSync } from "../messages/messages.ts";
import { readWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";

export type {
  CreateWorkspaceNotificationInput,
  WorkspaceNotificationRecipient,
  WorkspaceNotificationRecord,
  WorkspaceNotificationRecipientType,
  WorkspaceNotificationResourceType,
  WorkspaceNotificationSeverity,
  WorkspaceNotificationStatus,
};

export function createNotificationSync(input: CreateWorkspaceNotificationInput): WorkspaceNotificationRecord {
  return createWorkspaceNotificationSync(input);
}

export function createNotificationsSync(inputs: CreateWorkspaceNotificationInput[]): WorkspaceNotificationRecord[] {
  return createWorkspaceNotificationsSync(inputs);
}

export function listNotificationsForRecipientSync(input: {
  workspaceId: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
  status?: WorkspaceNotificationStatus | WorkspaceNotificationStatus[];
  includeArchived?: boolean;
  limit?: number;
}): WorkspaceNotificationRecord[] {
  return listWorkspaceNotificationsForRecipientSync(input);
}

export function markNotificationReadSync(input: {
  workspaceId: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): WorkspaceNotificationRecord | null {
  return markWorkspaceNotificationReadSync(input);
}

export function archiveNotificationSync(input: {
  workspaceId: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): WorkspaceNotificationRecord | null {
  return archiveWorkspaceNotificationSync(input);
}

export function countUnreadNotificationsSync(input: {
  workspaceId: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
}): number {
  return countUnreadWorkspaceNotificationsSync(input);
}

export function postNotificationChannelMessageSync(input: {
  workspaceId: string;
  channelName: string;
  summary: string;
  code: string;
  data?: Record<string, string | undefined>;
  speaker?: string;
  status?: "pending" | "completed" | "error";
  allowDirectChannel?: boolean;
}): boolean {
  const channelName = input.channelName.trim();
  if (!channelName) {
    return false;
  }
  const state = readWorkspaceStateSync(input.workspaceId);
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (!channel || (channel.kind === "direct" && !input.allowDirectChannel)) {
    return false;
  }

  postMessageSync({
    channel: channel.name,
    speaker: input.speaker ?? "系统提示",
    role: "agent",
    summary: input.summary,
    code: input.code,
    data: compactStringRecord(input.data ?? {}),
    status: input.status,
  }, input.workspaceId);
  return true;
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim()) {
      output[key] = value;
    }
  }
  return output;
}

export function notifyWorkspaceAdminsSync(input: {
  workspaceId: string;
  title: string;
  body: string;
  type: string;
  severity: WorkspaceNotificationSeverity;
  resourceType?: WorkspaceNotificationResourceType;
  resourceId?: string;
  actionHref?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}): WorkspaceNotificationRecord[] {
  const admins = listWorkspaceMemberUsersSync(input.workspaceId).filter(
    (member) => member.role === "owner" || member.role === "admin",
  );
  if (admins.length === 0) {
    return [];
  }

  return createNotificationsSync(
    admins.map((admin) => ({
      workspaceId: input.workspaceId,
      recipientType: "human" as const,
      recipientId: admin.userId,
      actorType: "system" as const,
      actorId: "system",
      type: input.type,
      title: input.title,
      body: input.body,
      severity: input.severity,
      resourceType: input.resourceType ?? "workspace",
      resourceId: input.resourceId,
      actionHref: input.actionHref,
      dedupeKey: input.dedupeKey,
      metadata: input.metadata,
    })),
  );
}
