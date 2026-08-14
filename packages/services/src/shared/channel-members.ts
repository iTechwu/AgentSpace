// 频道人类成员名解析：纯函数，供 channels / documents/access 等共享，
// 位于 shared 层以保证依赖单向（域模块不得互相引用以取得此能力）。
import type { WorkspaceRole } from "@dofe-agent/db";
import type { ChannelRecord, DofeAgentState } from "@dofe-agent/domain/workspace";
import { uniqueNames } from "./helpers.ts";

export function isWorkspaceAdminOrOwnerRole(role?: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function resolveChannelHumanMemberNames(
  state: DofeAgentState,
  channel: Pick<ChannelRecord, "humanMemberNames" | "humanMembers">,
): string[] {
  const explicitNames = uniqueNames(channel.humanMemberNames ?? []);
  if (explicitNames.length > 0) {
    return explicitNames;
  }

  return state.humanMembers
    .slice(0, Math.max(0, channel.humanMembers))
    .map((member) => member.name);
}

export function resolveChannelHumanMemberCount(
  state: DofeAgentState,
  channel: Pick<ChannelRecord, "humanMemberNames" | "humanMembers">,
): number {
  return resolveChannelHumanMemberNames(state, channel).length;
}
