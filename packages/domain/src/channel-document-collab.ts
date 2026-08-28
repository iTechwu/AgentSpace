export type ChannelDocumentBlockType = "section";
export type ChannelDocumentChangeSetStatus = "pending" | "applied" | "conflicted" | "rejected";
export type ChannelDocumentConflictStatus = "open" | "resolved";
export type ChannelDocumentPresenceStatus = "viewing" | "editing" | "processing";
export type DocumentAccessRole = "owner" | "forwarder" | "editor" | "viewer";
export type AgentAssignableDocumentAccessRole = Exclude<DocumentAccessRole, "owner">;
export type DocumentAction = "view" | "edit" | "forward" | "manage";
export type ChannelDocumentAccessRole = DocumentAccessRole;

export interface AgentDocumentContext {
  documentId: string;
  role: DocumentAccessRole;
  source: "channel_context" | "explicit_grant" | "forward_grant";
  allowedActions: DocumentAction[];
}

export function allowsDocumentAction(
  role: DocumentAccessRole | undefined | null,
  action: DocumentAction,
): boolean {
  if (!role) {
    return false;
  }
  if (role === "owner") {
    return action === "view" || action === "edit" || action === "forward" || action === "manage";
  }
  if (role === "forwarder") {
    return action === "view" || action === "edit" || action === "forward";
  }
  if (role === "editor") {
    return action === "view" || action === "edit";
  }
  return action === "view";
}

export function getAllowedDocumentActions(role: DocumentAccessRole): DocumentAction[] {
  return (["view", "edit", "forward", "manage"] as const).filter((action) => allowsDocumentAction(role, action));
}

export interface ChannelDocumentBlock {
  id: string;
  documentId: string;
  parentId?: string;
  type: ChannelDocumentBlockType;
  order: number;
  heading?: string;
  contentMarkdown: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface ChannelDocumentChangeSet {
  id: string;
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  baseVersionId: string;
  documentVersionId?: string;
  operationsJson: string;
  status: ChannelDocumentChangeSetStatus;
  sourceMessageId?: string;
  sourceTaskQueueId?: string;
  createdAt: string;
}

export interface ChannelDocumentConflict {
  id: string;
  documentId: string;
  blockId: string;
  leftChangeSetId: string;
  rightChangeSetId: string;
  status: ChannelDocumentConflictStatus;
  createdAt: string;
}

export interface ChannelDocumentAccess {
  id: string;
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDocumentPresence {
  id: string;
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  status: ChannelDocumentPresenceStatus;
  updatedAt: string;
}
