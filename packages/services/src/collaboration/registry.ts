import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type {
  CollaborativeObjectRef,
  CollaborativeObjectType,
} from "@dofe-agent/domain";
import type { DofeAgentState } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";

export interface CollaborativeObjectInput {
  objectType: CollaborativeObjectType;
  objectId: string;
}

export function resolveCollaborativeObjectSync(
  input: CollaborativeObjectInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborativeObjectRef {
  return resolveCollaborativeObject(ensureWorkspaceStateSync(workspaceId), input, workspaceId);
}

export function resolveCollaborativeObject(
  state: DofeAgentState,
  input: CollaborativeObjectInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborativeObjectRef {
  const objectId = input.objectId.trim();
  if (!objectId) {
    throw new Error("Collaborative object id is required.");
  }

  if (input.objectType === "channel") {
    const channel = state.channels.find((item) => sameValue(item.name, objectId));
    if (!channel) {
      throw new Error(`Collaborative object "channel:${objectId}" does not exist.`);
    }
    return { workspaceId, objectType: input.objectType, objectId: channel.name, title: channel.name };
  }

  if (input.objectType === "channel_document") {
    const document = state.channelDocuments.find((item) => item.id === objectId);
    if (!document) {
      throw new Error(`Collaborative object "channel_document:${objectId}" does not exist.`);
    }
    return { workspaceId, objectType: input.objectType, objectId: document.id, title: document.title };
  }

  if (input.objectType === "task") {
    const task = state.tasks.find((item) => item.id === objectId);
    if (!task) {
      throw new Error(`Collaborative object "task:${objectId}" does not exist.`);
    }
    return { workspaceId, objectType: input.objectType, objectId: task.id, title: task.title };
  }

  if (input.objectType === "knowledge_page") {
    const page = state.knowledgePages.find((item) => item.id === objectId);
    if (!page) {
      throw new Error(`Collaborative object "knowledge_page:${objectId}" does not exist.`);
    }
    return { workspaceId, objectType: input.objectType, objectId: page.id, title: page.title };
  }

  if (input.objectType === "data_table") {
    const table = state.dataTables.find((item) => item.id === objectId);
    if (!table) {
      throw new Error(`Collaborative object "data_table:${objectId}" does not exist.`);
    }
    return { workspaceId, objectType: input.objectType, objectId: table.id, title: table.name };
  }

  throw new Error(`Collaborative object type "${input.objectType}" is not registered yet.`);
}
