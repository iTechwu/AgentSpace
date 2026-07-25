import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type {
  CollaborationActivity,
  CollaborationActorRef,
  CollaborativeObjectType,
} from "@dofe-agent/domain";
import type { DofeAgentState } from "@dofe-agent/domain/workspace";
import { createOpaqueId } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { resolveCollaborativeObject } from "./registry.ts";

export interface CollaborationObjectFilter {
  objectType?: CollaborativeObjectType;
  objectId?: string;
}

export function listCollaborationActivitiesSync(
  filter: CollaborationObjectFilter = {},
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationActivity[] {
  return filterCollaborationActivities(ensureWorkspaceStateSync(workspaceId).collaborationActivities, filter);
}

export function recordCollaborationActivitySync(
  input: {
    objectType: CollaborativeObjectType;
    objectId: string;
    actor: CollaborationActorRef;
    verb: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationActivity {
  const state = ensureWorkspaceStateSync(workspaceId);
  const activity = appendCollaborationActivity(state, input, workspaceId);
  writeWorkspaceStateSync(state, workspaceId);
  return activity;
}

export function appendCollaborationActivity(
  state: DofeAgentState,
  input: {
    objectType: CollaborativeObjectType;
    objectId: string;
    actor: CollaborationActorRef;
    verb: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationActivity {
  const object = resolveCollaborativeObject(state, input, workspaceId);
  const actorId = input.actor.id.trim();
  const verb = input.verb.trim();
  const title = input.title.trim();
  if (!actorId) {
    throw new Error("Collaboration activity actor id is required.");
  }
  if (!verb) {
    throw new Error("Collaboration activity verb is required.");
  }
  if (!title) {
    throw new Error("Collaboration activity title is required.");
  }

  const activity: CollaborationActivity = {
    id: `collab-activity-${createOpaqueId()}`,
    workspaceId,
    objectType: object.objectType,
    objectId: object.objectId,
    actorType: input.actor.type,
    actorId,
    verb,
    title,
    body: input.body?.trim() ?? "",
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
  state.collaborationActivities.unshift(activity);
  return activity;
}

function filterCollaborationActivities(
  activities: CollaborationActivity[],
  filter: CollaborationObjectFilter,
): CollaborationActivity[] {
  return activities.filter((activity) => {
    if (filter.objectType && activity.objectType !== filter.objectType) {
      return false;
    }
    if (filter.objectId && activity.objectId !== filter.objectId) {
      return false;
    }
    return true;
  });
}
