// 频道参与 / 访问请求 / 邀请（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


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
