export type CollaborativeObjectType =
  | "channel"
  | "channel_document"
  | "data_table"
  | "task"
  | "knowledge_page"
  | "todo"
  | "agent_draft"
  | "file";

export type CollaborationActorType = "human" | "agent" | "system";

export interface CollaborationActorRef {
  type: CollaborationActorType;
  id: string;
  displayName?: string;
}

export interface CollaborativeObjectRef {
  workspaceId: string;
  objectType: CollaborativeObjectType;
  objectId: string;
  title: string;
}

export type CollaborationCommentThreadStatus = "open" | "resolved";

export interface CollaborationCommentThread {
  id: string;
  workspaceId: string;
  objectType: CollaborativeObjectType;
  objectId: string;
  anchor: Record<string, unknown>;
  status: CollaborationCommentThreadStatus;
  createdByType: CollaborationActorType;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationComment {
  id: string;
  workspaceId: string;
  threadId: string;
  authorType: CollaborationActorType;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationCommentThreadWithComments extends CollaborationCommentThread {
  comments: CollaborationComment[];
}

export interface CollaborationActivity {
  id: string;
  workspaceId: string;
  objectType: CollaborativeObjectType;
  objectId: string;
  actorType: CollaborationActorType;
  actorId: string;
  verb: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type CollaborationChangeProposalStatus = "open" | "accepted" | "rejected" | "changes_requested";

export interface CollaborationChangeProposal {
  id: string;
  workspaceId: string;
  objectType: CollaborativeObjectType;
  objectId: string;
  proposedByType: CollaborationActorType;
  proposedById: string;
  title: string;
  summary: string;
  patch: Record<string, unknown>;
  status: CollaborationChangeProposalStatus;
  createdAt: string;
  updatedAt: string;
  decidedByUserId?: string;
  decidedAt?: string;
}
