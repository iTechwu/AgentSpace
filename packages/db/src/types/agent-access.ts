// Agent 访问请求（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


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
