import type { ActiveEmployee, DofeAgentState, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, uniqueNames } from "../shared/helpers.ts";

export interface ContactContextEntity {
  type: "employee";
  name: string;
  role: string;
  relationship: "workspace-collaborator";
  sharedChannels: string[];
  observedLabels: string[];
  recentSharedInteractionChannel?: string;
  recentSharedInteractionTime?: string;
  recentSharedInteractionSummary?: string;
}

export interface ContactAgentContext {
  self: {
    name: string;
    role: string;
    channels: string[];
  };
  knownEntities: ContactContextEntity[];
}

export function buildContactAgentContextSync(agentName: string): ContactAgentContext {
  return buildContactAgentContext(ensureWorkspaceStateSync(), agentName);
}

export function buildContactAgentContext(state: DofeAgentState, agentName: string): ContactAgentContext {
  const self = state.activeEmployees.find((employee) => sameValue(employee.name, agentName));
  const selfChannels = self?.channels ?? [];

  if (!self) {
    return {
      self: {
        name: agentName,
        role: "Agent",
        channels: [],
      },
      knownEntities: [],
    };
  }

  const knownEntities = state.activeEmployees
    .filter((employee) => !sameValue(employee.name, self.name))
    .map((employee) => buildContactContextEntity(state, self, employee))
    .filter((entity): entity is ContactContextEntity => entity !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }));

  return {
    self: {
      name: self.name,
      role: self.role,
      channels: [...selfChannels],
    },
    knownEntities,
  };
}

function buildContactContextEntity(
  state: DofeAgentState,
  self: ActiveEmployee,
  candidate: ActiveEmployee,
): ContactContextEntity | undefined {
  const sharedChannels = getSharedChannels(self, candidate);
  if (sharedChannels.length === 0) {
    return undefined;
  }

  const recentInteraction = findRecentSharedInteraction(state.messages, self.name, candidate.name, sharedChannels);

  return {
    type: "employee",
    name: candidate.name,
    role: candidate.role,
    relationship: "workspace-collaborator",
    sharedChannels,
    observedLabels: collectObservedLabels(state.messages, candidate.name, sharedChannels),
    recentSharedInteractionChannel: recentInteraction?.channel,
    recentSharedInteractionTime: recentInteraction?.time,
    recentSharedInteractionSummary: recentInteraction?.summary,
  };
}

function getSharedChannels(self: ActiveEmployee, candidate: ActiveEmployee): string[] {
  return uniqueNames(
    self.channels.filter((channelName) => candidate.channels.some((item) => sameValue(item, channelName))),
  );
}

function collectObservedLabels(
  messages: DofeAgentState["messages"],
  entityName: string,
  sharedChannels: string[],
): string[] {
  const labels: string[] = [];

  for (const message of messages) {
    const channelName = message.channel;
    if (!channelName || !sharedChannels.some((sharedChannel) => sameValue(sharedChannel, channelName))) {
      continue;
    }

    for (const mention of message.mentions ?? []) {
      if (mention.mentionType !== "agent" || !sameValue(mention.agentId, entityName)) {
        continue;
      }
      const token = mention.token.trim();
      if (!token || sameValue(token, entityName)) {
        continue;
      }
      labels.push(token);
    }
  }

  return uniqueNames(labels);
}

function findRecentSharedInteraction(
  messages: DofeAgentState["messages"],
  selfName: string,
  entityName: string,
  sharedChannels: string[],
): { channel: string; time?: string; summary: string } | undefined {
  let best:
    | {
        score: number;
        channel: string;
        time?: string;
        summary: string;
      }
    | undefined;

  for (const message of messages) {
    const channelName = message.channel;
    if (!channelName || !sharedChannels.some((sharedChannel) => sameValue(sharedChannel, channelName))) {
      continue;
    }
    if (message.status === "pending") {
      continue;
    }

    const score = scoreSharedInteraction(message, selfName, entityName);
    if (score === 0) {
      continue;
    }

    if (!best || score > best.score) {
      best = {
        score,
        channel: channelName,
        time: message.time,
        summary: truncateInteractionSummary(message.summary),
      };
    }
  }

  if (!best) {
    return undefined;
  }

  return {
    channel: best.channel,
    time: best.time,
    summary: best.summary,
  };
}

function scoreSharedInteraction(message: WorkspaceMessage, selfName: string, entityName: string): number {
  const mentionsSelf = message.mentions?.some((mention) => mention.mentionType === "agent" && sameValue(mention.agentId, selfName)) ?? false;
  const mentionsEntity = message.mentions?.some((mention) => mention.mentionType === "agent" && sameValue(mention.agentId, entityName)) ?? false;
  const speakerIsSelf = sameValue(message.speaker, selfName);
  const speakerIsEntity = sameValue(message.speaker, entityName);

  if ((speakerIsEntity && mentionsSelf) || (speakerIsSelf && mentionsEntity)) {
    return 5;
  }
  if (mentionsSelf && mentionsEntity) {
    return 4;
  }
  if (speakerIsEntity && mentionsEntity) {
    return 3;
  }
  if (mentionsEntity) {
    return 2;
  }
  if (speakerIsEntity) {
    return 1;
  }
  return 0;
}

function truncateInteractionSummary(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 180) {
    return trimmed;
  }
  return `${trimmed.slice(0, 177)}...`;
}
