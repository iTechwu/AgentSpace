import type { DofeAgentState, ChannelDocument, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, uniqueNames } from "../shared/helpers.ts";
import { buildContactAgentContext, type ContactContextEntity } from "./provider.ts";

export interface WorkspaceContextChannelSummary {
  name: string;
  memberNames: string[];
  documentCount: number;
}

export interface WorkspaceContextMessageResult {
  channelName: string;
  speaker: string;
  summary: string;
  time?: string;
}

export function listWorkspaceContextEntitiesSync(agentName: string, workspaceId?: string): ContactContextEntity[] {
  return listWorkspaceContextEntities(ensureWorkspaceStateSync(workspaceId), agentName);
}

export function listWorkspaceContextEntities(state: DofeAgentState, agentName: string): ContactContextEntity[] {
  return buildContactAgentContext(state, agentName).knownEntities;
}

export function resolveWorkspaceContextEntitySync(
  agentName: string,
  query: string,
  workspaceId?: string,
): ContactContextEntity | undefined {
  return resolveWorkspaceContextEntity(ensureWorkspaceStateSync(workspaceId), agentName, query);
}

export function resolveWorkspaceContextEntity(
  state: DofeAgentState,
  agentName: string,
  query: string,
): ContactContextEntity | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  return listWorkspaceContextEntities(state, agentName).find(
    (entity) =>
      sameValue(entity.name, trimmed) || entity.observedLabels.some((label) => sameValue(label, trimmed)),
  );
}

export function listWorkspaceContextChannelsSync(agentName: string, workspaceId?: string): WorkspaceContextChannelSummary[] {
  return listWorkspaceContextChannels(ensureWorkspaceStateSync(workspaceId), agentName);
}

export function listWorkspaceContextChannels(
  state: DofeAgentState,
  agentName: string,
): WorkspaceContextChannelSummary[] {
  const visibleChannels = getVisibleChannels(state, agentName);

  return visibleChannels.map((channelName) => {
    const channel = state.channels.find((item) => sameValue(item.name, channelName));
    return {
      name: channelName,
      memberNames: channel?.employeeNames.filter((item) => !sameValue(item, agentName)) ?? [],
      documentCount: state.channelDocuments.filter(
        (document) => sameValue(document.channelName, channelName) && document.status === "active",
      ).length,
    };
  });
}

export function listWorkspaceContextDocumentsSync(
  agentName: string,
  channelName?: string,
  workspaceId?: string,
): ChannelDocument[] {
  return listWorkspaceContextDocuments(ensureWorkspaceStateSync(workspaceId), agentName, channelName);
}

export function listWorkspaceContextDocuments(
  state: DofeAgentState,
  agentName: string,
  channelName?: string,
): ChannelDocument[] {
  const visibleChannels = getVisibleChannels(state, agentName);
  const canReadSpecificChannel =
    !channelName || visibleChannels.some((visibleChannel) => sameValue(visibleChannel, channelName));

  if (!canReadSpecificChannel) {
    return [];
  }

  return state.channelDocuments.filter((document) => {
    if (document.status !== "active") {
      return false;
    }
    if (channelName && !sameValue(document.channelName, channelName)) {
      return false;
    }
    return visibleChannels.some((visibleChannel) => sameValue(visibleChannel, document.channelName));
  });
}

export function searchWorkspaceContextMessagesSync(
  agentName: string,
  query: string,
  channelName?: string,
  workspaceId?: string,
): WorkspaceContextMessageResult[] {
  return searchWorkspaceContextMessages(ensureWorkspaceStateSync(workspaceId), agentName, query, channelName);
}

export function searchWorkspaceContextMessages(
  state: DofeAgentState,
  agentName: string,
  query: string,
  channelName?: string,
): WorkspaceContextMessageResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const visibleChannels = getVisibleChannels(state, agentName);
  const lowerQuery = trimmed.toLocaleLowerCase("zh-CN");

  return state.messages
    .filter((message) => isVisibleMessage(message, visibleChannels, channelName))
    .filter((message) => message.summary.toLocaleLowerCase("zh-CN").includes(lowerQuery))
    .slice(0, 20)
    .map((message) => ({
      channelName: message.channel ?? "",
      speaker: message.speaker,
      summary: message.summary,
      time: message.time,
    }));
}

function getVisibleChannels(state: DofeAgentState, agentName: string): string[] {
  const self = state.activeEmployees.find((employee) => sameValue(employee.name, agentName));
  if (!self) {
    return [];
  }

  return uniqueNames(self.channels);
}

function isVisibleMessage(
  message: WorkspaceMessage,
  visibleChannels: string[],
  channelName?: string,
): boolean {
  if (!message.channel) {
    return false;
  }
  if (!visibleChannels.some((visibleChannel) => sameValue(visibleChannel, message.channel ?? ""))) {
    return false;
  }
  if (channelName && !sameValue(channelName, message.channel)) {
    return false;
  }
  if (message.status === "pending") {
    return false;
  }
  return true;
}
