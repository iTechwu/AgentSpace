// 频道域视图构建：频道列表项、直聊定位、可见频道名与提及未读检测。
// resolveDirectChannelForContact 会经 services 读取频道 ACL（canReadChannelForActorSync）。
import { canReadChannelForActorSync, resolveChannelHumanMemberNames } from "@dofe-agent/services/channels";
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelRecord,
  DofeAgentState,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelListItem,
} from "../data-types";
import { sameText } from "./text";

export function isDirectChannelRecord(channel: Pick<ChannelRecord, "kind">): boolean {
  return channel.kind === "direct";
}

export function normalizeChannelScope(channelNames?: string[]): Set<string> | null {
  if (!channelNames) {
    return null;
  }
  const normalized = channelNames.map((name) => name.trim()).filter(Boolean);
  return new Set(normalized);
}

export function resolveDirectChannelForContact(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
  employeeName: string,
  workspaceId?: string,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): ChannelRecord | null {
  const candidates = state.channels.filter(
    (channel) =>
      isDirectChannelRecord(channel) &&
      channel.employeeNames.some((name) => sameText(name, employeeName)),
  );
  if (candidates.length === 0) {
    return null;
  }

  if (workspaceId && currentUserId) {
    return (
      candidates.find((channel) =>
        canReadChannelForActorSync({
          workspaceId,
          channelName: channel.name,
          actor: {
            userId: currentUserId,
            displayName: currentUserDisplayName,
            role: currentMembershipRole,
          },
        }),
      ) ?? null
    );
  }

  if (currentUserDisplayName?.trim()) {
    return (
      candidates.find((channel) =>
        (channel.humanMemberNames ?? []).some((name) => sameText(name, currentUserDisplayName)),
      ) ?? null
    );
  }

  return candidates[0] ?? null;
}

function resolveChannelMemberCount(channel: Pick<ChannelRecord, "humanMembers" | "employeeNames">): number {
  const humanCount = Array.isArray((channel as { humanMemberNames?: string[] }).humanMemberNames)
    ? ((channel as { humanMemberNames?: string[] }).humanMemberNames?.length ?? channel.humanMembers)
    : channel.humanMembers;
  return Math.max(0, humanCount) + channel.employeeNames.length;
}

export function buildChannelListItem(
  channel: ChannelRecord,
  state: DofeAgentState,
): ChannelListItem {
  if (isDirectChannelRecord(channel)) {
    const directEmployee = state.activeEmployees.find((employee) =>
      channel.employeeNames.some((name) => sameText(name, employee.name)),
    );
    const humanDirectNames = directEmployee ? [] : resolveChannelHumanMemberNames(state, channel);
    const humanDirectDisplayName = humanDirectNames.length > 0 ? humanDirectNames.join(" / ") : channel.name;
    return {
      id: channel.name,
      name: channel.name,
      memberLabel: `${resolveChannelMemberCount(channel)} humans / ${channel.employeeNames.length} agents`,
      humanMemberNames: resolveChannelHumanMemberNames(state, channel),
      employeeNames: [...channel.employeeNames],
      kind: "direct",
      directParticipantKind: directEmployee ? "agent" : "human",
      displayName: directEmployee?.remarkName?.trim() || directEmployee?.name || humanDirectDisplayName,
      displaySubtitle: directEmployee?.name || "Human direct",
      avatarLabel: directEmployee ? "✦" : humanDirectDisplayName.slice(0, 1).toUpperCase(),
      memberCount: resolveChannelMemberCount(channel),
      canManage: false,
    };
  }

  return {
    id: channel.name,
    name: channel.name,
    memberLabel: `${resolveChannelMemberCount(channel)} humans / ${channel.employeeNames.length} agents`,
    humanMemberNames: resolveChannelHumanMemberNames(state, channel),
    employeeNames: [...channel.employeeNames],
    kind: "group",
    displayName: channel.name,
    avatarLabel: "#",
    memberCount: resolveChannelMemberCount(channel),
    canManage: true,
  };
}

export interface MentionUnreadViewer {
  userId?: string;
  displayName?: string;
  ownedAgentNames: Set<string>;
}

export function buildMentionUnreadViewer(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
  currentUserId: string | undefined,
): MentionUnreadViewer {
  return {
    userId: currentUserId,
    displayName: currentUserDisplayName?.trim() || undefined,
    ownedAgentNames: new Set(
      currentUserId
        ? (state.activeEmployees ?? [])
            .filter((employee) => employee.ownerUserId === currentUserId)
            .map((employee) => employee.name)
        : [],
    ),
  };
}

export function hasUnreadMentionForViewer(messagesNewestFirst: WorkspaceMessage[], viewer: MentionUnreadViewer): boolean {
  if (!viewer.displayName && viewer.ownedAgentNames.size === 0) {
    return false;
  }

  for (const message of messagesNewestFirst) {
    if (viewer.displayName && sameText(message.speaker, viewer.displayName)) {
      return false;
    }

    const mentionsViewer = message.mentions?.some((mention) => isMentionForViewer(mention, viewer)) ?? false;
    if (mentionsViewer && !isMessageAcknowledgedByViewer(message, viewer)) {
      return true;
    }
  }

  return false;
}

function isMentionForViewer(
  mention: NonNullable<WorkspaceMessage["mentions"]>[number],
  viewer: MentionUnreadViewer,
): boolean {
  if (mention.mentionType === "human") {
    return Boolean(
      viewer.displayName
        && (
          sameText(mention.humanId, viewer.displayName)
          || sameText(mention.label, viewer.displayName)
          || sameText(mention.token, viewer.displayName)
        ),
    );
  }

  return Array.from(viewer.ownedAgentNames).some((agentName) =>
    sameText(mention.agentId, agentName) || sameText(mention.label, agentName),
  );
}

function isMessageAcknowledgedByViewer(message: WorkspaceMessage, viewer: MentionUnreadViewer): boolean {
  return message.acknowledgements?.some((acknowledgement) => {
    if (viewer.userId && acknowledgement.userId === viewer.userId) {
      return true;
    }
    if (viewer.displayName && sameText(acknowledgement.label, viewer.displayName)) {
      return true;
    }
    return Array.from(viewer.ownedAgentNames).some((agentName) => sameText(acknowledgement.label, agentName));
  }) ?? false;
}

export function getVisibleWorkspaceChannelNames(
  state: DofeAgentState,
  currentUserDisplayName?: string,
): Set<string> {
  if (!currentUserDisplayName?.trim()) {
    return new Set();
  }

  return new Set(
    state.channels
      .filter((channel) =>
        resolveChannelHumanMemberNames(state, channel).some((memberName) => sameText(memberName, currentUserDisplayName)),
      )
      .map((channel) => channel.name),
  );
}
