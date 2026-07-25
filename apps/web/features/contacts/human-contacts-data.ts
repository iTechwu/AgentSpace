import { listWorkspaceMemberUsersSync } from "@dofe-agent/db";
import type { WorkspaceMessage } from "@dofe-agent/domain/workspace";
import {
  readWorkspaceStateSnapshotSync,
  resolveHumanDirectChannelForUsersSync,
} from "@dofe-agent/services";

export interface HumanContactItem {
  id: string;
  name: string;
  subtitle: string;
  email?: string;
  role: string;
  directChannelName?: string;
  lastMessage?: string;
  updatedAt?: string;
}

export interface HumanContactThread {
  contactId: string;
  channelName?: string;
  messages: WorkspaceMessage[];
}

export interface HumanContactsPageData {
  channels: string[];
  contacts: HumanContactItem[];
  threads: HumanContactThread[];
}

export function getHumanContactsPageData(input: {
  workspaceId: string;
  currentUserId: string;
}): HumanContactsPageData {
  const state = readWorkspaceStateSnapshotSync(input.workspaceId);
  const members = listWorkspaceMemberUsersSync(input.workspaceId);
  const groupChannels = state.channels
    .filter((channel) => channel.kind !== "direct")
    .map((channel) => channel.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }));

  const contacts = members
    .filter((member) => member.userId !== input.currentUserId)
    .map((member) => {
      const directChannel = resolveHumanDirectChannelForUsersSync({
        workspaceId: input.workspaceId,
        state,
        userIds: [input.currentUserId, member.userId],
      });
      const latestMessage = directChannel
        ? state.messages.find((message) => message.channel === directChannel.name)
        : undefined;
      return {
        id: member.userId,
        name: member.displayName,
        subtitle: formatContactSubtitle(member.role, member.primaryEmail),
        email: member.primaryEmail,
        role: formatRoleLabel(member.role),
        directChannelName: directChannel?.name,
        lastMessage: latestMessage?.summary,
        updatedAt: latestMessage?.time,
      } satisfies HumanContactItem;
    })
    .sort((left, right) => {
      if (left.updatedAt && !right.updatedAt) {
        return -1;
      }
      if (!left.updatedAt && right.updatedAt) {
        return 1;
      }
      return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
    });

  return {
    channels: groupChannels,
    contacts,
    threads: contacts.map((contact) => ({
      contactId: contact.id,
      channelName: contact.directChannelName,
      messages: contact.directChannelName
        ? state.messages
            .filter((message) => message.channel === contact.directChannelName)
            .slice()
            .reverse()
        : [],
    })),
  };
}

function formatContactSubtitle(role: string, email?: string): string {
  const label = formatRoleLabel(role);
  return email ? `${label} / ${email}` : label;
}

function formatRoleLabel(role: string): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "admin") {
    return "Admin";
  }
  return "Member";
}
