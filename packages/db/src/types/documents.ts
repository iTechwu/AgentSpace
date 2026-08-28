// 文档代理访问与权限请求（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


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
