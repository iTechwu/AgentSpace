// 频道访问判定（读/写）：纯函数 + workspace 级只读 DB 读取，不依赖
// channel-access 域。下沉 shared 层后 attachments / documents / messages /
// integrations 等多个域可直接消费该判定，attachments → channel-access
// 反向依赖随之切断（依赖单向：域 → shared）。
//
// 域层面的写操作（access request / invitation / participant 变更）仍由
// channel-access.ts 提供；本模块只承载「actor 在某频道能否读/写」这一
// 只读判定逻辑。

import {
  listChannelParticipantsSync,
  readChannelParticipantSync,
  readUserSync,
  readWorkspaceMembershipSync,
  type WorkspaceRole,
} from "@dofe-agent/db";
import type { ChannelRecord, DofeAgentState } from "@dofe-agent/domain/workspace";
import { isWorkspaceAdminOrOwnerRole, resolveChannelHumanMemberNames } from "./channel-members.ts";
import { sameValue } from "./helpers.ts";
import { ensureWorkspaceStateSync } from "./state-io.ts";

export interface ChannelAccessActor {
  userId: string;
  displayName?: string;
  role?: WorkspaceRole;
}

export function canReadChannelForActorSync(input: {
  workspaceId: string;
  channelName?: string | null;
  actor: ChannelAccessActor;
}): boolean {
  const channelName = input.channelName?.trim();
  if (!channelName) {
    return true;
  }
  const state = ensureWorkspaceStateSync(input.workspaceId);
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (channel?.kind === "direct") {
    return canReadDirectChannelForActorSync({
      workspaceId: input.workspaceId,
      channel,
      actor: input.actor,
      state,
    });
  }
  if (isWorkspaceAdminOrOwnerRole(resolveActorRole(input.workspaceId, input.actor))) {
    return true;
  }
  if (!input.actor.userId.trim()) {
    return false;
  }
  const participant = readChannelParticipantSync(input.workspaceId, channelName, input.actor.userId);
  if (participant?.status === "active") {
    return true;
  }

  return canReadChannelByLegacyMembership(input.workspaceId, channelName, input.actor);
}

export function canReadDirectChannelForActorSync(input: {
  workspaceId: string;
  channel: ChannelRecord;
  actor: ChannelAccessActor;
  state?: DofeAgentState;
}): boolean {
  const actorUserId = input.actor.userId.trim();
  if (!actorUserId) {
    return false;
  }
  const participant = readChannelParticipantSync(input.workspaceId, input.channel.name, actorUserId);
  if (participant?.status === "active") {
    return true;
  }

  const state = input.state ?? ensureWorkspaceStateSync(input.workspaceId);
  const actorDisplayName = input.actor.displayName?.trim() || readUserSync(actorUserId)?.displayName;
  if (
    actorDisplayName &&
    resolveChannelHumanMemberNames(state, input.channel).some((name) => sameValue(name, actorDisplayName))
  ) {
    return true;
  }

  return input.channel.employeeNames.some((employeeName) => {
    const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
    return employee?.ownerUserId === actorUserId;
  });
}

export function canWriteChannelForActorSync(input: {
  workspaceId: string;
  channelName?: string | null;
  actor: ChannelAccessActor;
}): boolean {
  return canReadChannelForActorSync(input);
}

// Exported for channel-access.ts orchestration helpers (e.g.
// listChannelInvitationsForActorSync / assertWorkspaceManager) that need the
// same actor-role resolution without depending back on this module.
export function resolveActorRole(workspaceId: string, actor: ChannelAccessActor): WorkspaceRole | undefined {
  if (actor.role) {
    return actor.role;
  }
  return readWorkspaceMembershipSync(workspaceId, actor.userId)?.role;
}

function canReadChannelByLegacyMembership(
  workspaceId: string,
  channelName: string,
  actor: ChannelAccessActor,
): boolean {
  const state = ensureWorkspaceStateSync(workspaceId);
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (!channel) {
    return false;
  }
  const hasStructuredAccessRows = listChannelParticipantsSync(workspaceId, channel.name, {
    statuses: ["active", "removed"],
  }).length > 0;
  if (hasStructuredAccessRows) {
    return false;
  }

  const displayName = actor.displayName?.trim() || readUserSync(actor.userId)?.displayName;
  if (!displayName) {
    return false;
  }
  const visibleHumanNames = resolveChannelHumanMemberNames(state, channel);
  if (visibleHumanNames.length === 0) {
    // A channel that resolves to no human members must default to private
    // (deny). Returning true here would make memberless channels — e.g. ones
    // created via `createChannelSync({ name })` with no participants, such as
    // the CLI `channel create` path — readable by every workspace member.
    return false;
  }
  return visibleHumanNames.some((candidate) => sameValue(candidate, displayName));
}