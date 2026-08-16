// Agent Fork 邀请（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


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
