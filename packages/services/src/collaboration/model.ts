import type {
  CollaborationActivity,
  CollaborationChangeProposal,
  CollaborationComment,
  CollaborationCommentThread,
} from "@dofe-agent/domain";
import type { DofeAgentState } from "@dofe-agent/domain/workspace";

const OBJECT_TYPES = new Set([
  "channel",
  "channel_document",
  "data_table",
  "task",
  "knowledge_page",
  "todo",
  "agent_draft",
  "file",
]);
const ACTOR_TYPES = new Set(["human", "agent", "system"]);
const THREAD_STATUSES = new Set(["open", "resolved"]);
const PROPOSAL_STATUSES = new Set(["open", "accepted", "rejected", "changes_requested"]);

export function normalizeCollaborationCommentThreads(
  threads: DofeAgentState["collaborationCommentThreads"] | undefined,
  fallback: DofeAgentState["collaborationCommentThreads"],
): DofeAgentState["collaborationCommentThreads"] {
  if (!Array.isArray(threads)) {
    return fallback;
  }

  return threads
    .map((thread) => normalizeCollaborationCommentThread(thread))
    .filter((thread): thread is CollaborationCommentThread => thread !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function normalizeCollaborationComments(
  comments: DofeAgentState["collaborationComments"] | undefined,
  fallback: DofeAgentState["collaborationComments"],
): DofeAgentState["collaborationComments"] {
  if (!Array.isArray(comments)) {
    return fallback;
  }

  return comments
    .map((comment) => normalizeCollaborationComment(comment))
    .filter((comment): comment is CollaborationComment => comment !== null)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

export function normalizeCollaborationActivities(
  activities: DofeAgentState["collaborationActivities"] | undefined,
  fallback: DofeAgentState["collaborationActivities"],
): DofeAgentState["collaborationActivities"] {
  if (!Array.isArray(activities)) {
    return fallback;
  }

  return activities
    .map((activity) => normalizeCollaborationActivity(activity))
    .filter((activity): activity is CollaborationActivity => activity !== null)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function normalizeCollaborationChangeProposals(
  proposals: DofeAgentState["collaborationChangeProposals"] | undefined,
  fallback: DofeAgentState["collaborationChangeProposals"],
): DofeAgentState["collaborationChangeProposals"] {
  if (!Array.isArray(proposals)) {
    return fallback;
  }

  return proposals
    .map((proposal) => normalizeCollaborationChangeProposal(proposal))
    .filter((proposal): proposal is CollaborationChangeProposal => proposal !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function normalizeCollaborationCommentThread(thread: unknown): CollaborationCommentThread | null {
  if (!thread || typeof thread !== "object") {
    return null;
  }

  const candidate = thread as Partial<CollaborationCommentThread>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    !isObjectType(candidate.objectType) ||
    typeof candidate.objectId !== "string" ||
    !isActorType(candidate.createdByType) ||
    typeof candidate.createdById !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    anchor: asRecord(candidate.anchor),
    status: THREAD_STATUSES.has(candidate.status ?? "") ? candidate.status! : "open",
    createdByType: candidate.createdByType,
    createdById: candidate.createdById,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeCollaborationComment(comment: unknown): CollaborationComment | null {
  if (!comment || typeof comment !== "object") {
    return null;
  }

  const candidate = comment as Partial<CollaborationComment>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.threadId !== "string" ||
    !isActorType(candidate.authorType) ||
    typeof candidate.authorId !== "string" ||
    typeof candidate.body !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    threadId: candidate.threadId,
    authorType: candidate.authorType,
    authorId: candidate.authorId,
    body: candidate.body,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeCollaborationActivity(activity: unknown): CollaborationActivity | null {
  if (!activity || typeof activity !== "object") {
    return null;
  }

  const candidate = activity as Partial<CollaborationActivity>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    !isObjectType(candidate.objectType) ||
    typeof candidate.objectId !== "string" ||
    !isActorType(candidate.actorType) ||
    typeof candidate.actorId !== "string" ||
    typeof candidate.verb !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    actorType: candidate.actorType,
    actorId: candidate.actorId,
    verb: candidate.verb,
    title: candidate.title,
    body: typeof candidate.body === "string" ? candidate.body : "",
    metadata: asRecord(candidate.metadata),
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
  };
}

function normalizeCollaborationChangeProposal(proposal: unknown): CollaborationChangeProposal | null {
  if (!proposal || typeof proposal !== "object") {
    return null;
  }

  const candidate = proposal as Partial<CollaborationChangeProposal>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    !isObjectType(candidate.objectType) ||
    typeof candidate.objectId !== "string" ||
    !isActorType(candidate.proposedByType) ||
    typeof candidate.proposedById !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    proposedByType: candidate.proposedByType,
    proposedById: candidate.proposedById,
    title: candidate.title,
    summary: candidate.summary,
    patch: asRecord(candidate.patch),
    status: PROPOSAL_STATUSES.has(candidate.status ?? "") ? candidate.status! : "open",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    decidedByUserId: typeof candidate.decidedByUserId === "string" ? candidate.decidedByUserId : undefined,
    decidedAt: typeof candidate.decidedAt === "string" ? candidate.decidedAt : undefined,
  };
}

function isObjectType(value: unknown): value is CollaborationCommentThread["objectType"] {
  return typeof value === "string" && OBJECT_TYPES.has(value);
}

function isActorType(value: unknown): value is CollaborationComment["authorType"] {
  return typeof value === "string" && ACTOR_TYPES.has(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
