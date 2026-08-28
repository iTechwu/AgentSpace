import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type {
  CollaborationActorRef,
  CollaborationComment,
  CollaborationCommentThread,
  CollaborationCommentThreadWithComments,
  CollaborativeObjectType,
} from "@dofe-agent/domain";
import { createOpaqueId } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { appendCollaborationActivity } from "./activity.ts";
import { resolveCollaborativeObject } from "./registry.ts";

export function listCollaborationCommentThreadsSync(
  filter: {
    objectType?: CollaborativeObjectType;
    objectId?: string;
    status?: CollaborationCommentThread["status"];
  } = {},
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationCommentThreadWithComments[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  return state.collaborationCommentThreads
    .filter((thread) => {
      if (filter.objectType && thread.objectType !== filter.objectType) {
        return false;
      }
      if (filter.objectId && thread.objectId !== filter.objectId) {
        return false;
      }
      if (filter.status && thread.status !== filter.status) {
        return false;
      }
      return true;
    })
    .map((thread) => ({
      ...thread,
      comments: state.collaborationComments
        .filter((comment) => comment.threadId === thread.id)
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
    }));
}

export function createCollaborationCommentThreadSync(
  input: {
    objectType: CollaborativeObjectType;
    objectId: string;
    anchor?: Record<string, unknown>;
    createdBy: CollaborationActorRef;
    body: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationCommentThreadWithComments {
  const state = ensureWorkspaceStateSync(workspaceId);
  const object = resolveCollaborativeObject(state, input, workspaceId);
  const now = new Date().toISOString();
  const actorId = input.createdBy.id.trim();
  const body = input.body.trim();
  if (!actorId) {
    throw new Error("Comment thread creator id is required.");
  }
  if (!body) {
    throw new Error("Comment body is required.");
  }

  const thread: CollaborationCommentThread = {
    id: `collab-thread-${createOpaqueId()}`,
    workspaceId,
    objectType: object.objectType,
    objectId: object.objectId,
    anchor: input.anchor ?? {},
    status: "open",
    createdByType: input.createdBy.type,
    createdById: actorId,
    createdAt: now,
    updatedAt: now,
  };
  const comment = buildComment({
    workspaceId,
    threadId: thread.id,
    author: input.createdBy,
    body,
    now,
  });

  state.collaborationCommentThreads.unshift(thread);
  state.collaborationComments.unshift(comment);
  appendCollaborationActivity(
    state,
    {
      objectType: object.objectType,
      objectId: object.objectId,
      actor: input.createdBy,
      verb: "comment.created",
      title: `Commented on ${object.title}`,
      body,
      metadata: { threadId: thread.id, commentId: comment.id },
    },
    workspaceId,
  );
  writeWorkspaceStateSync(state, workspaceId);

  return { ...thread, comments: [comment] };
}

export function addCollaborationCommentSync(
  input: {
    threadId: string;
    author: CollaborationActorRef;
    body: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationComment {
  const state = ensureWorkspaceStateSync(workspaceId);
  const thread = state.collaborationCommentThreads.find((item) => item.id === input.threadId);
  if (!thread) {
    throw new Error(`Collaboration comment thread "${input.threadId}" does not exist.`);
  }
  const body = input.body.trim();
  if (!body) {
    throw new Error("Comment body is required.");
  }

  const now = new Date().toISOString();
  const comment = buildComment({
    workspaceId,
    threadId: thread.id,
    author: input.author,
    body,
    now,
  });
  thread.updatedAt = now;
  state.collaborationComments.unshift(comment);
  appendCollaborationActivity(
    state,
    {
      objectType: thread.objectType,
      objectId: thread.objectId,
      actor: input.author,
      verb: "comment.replied",
      title: "Replied to comment thread",
      body,
      metadata: { threadId: thread.id, commentId: comment.id },
    },
    workspaceId,
  );
  writeWorkspaceStateSync(state, workspaceId);
  return comment;
}

function buildComment(input: {
  workspaceId: string;
  threadId: string;
  author: CollaborationActorRef;
  body: string;
  now: string;
}): CollaborationComment {
  const authorId = input.author.id.trim();
  if (!authorId) {
    throw new Error("Comment author id is required.");
  }

  return {
    id: `collab-comment-${createOpaqueId()}`,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    authorType: input.author.type,
    authorId,
    body: input.body,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
