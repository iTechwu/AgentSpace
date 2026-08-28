// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/channels` 子路径与根 re-export 使用。

export {
  addChannelEmployeesSync,
  createChannelSync,
  deleteChannelSync,
  renameChannelSync,
  updateChannelHumanMemberNamesSync,
  ensureDirectChannelSync,
  resolveCompatibleDirectChannelRecord,
  resolveChannelHumanMemberNames,
  resolveChannelHumanMemberCount,
} from "./channels.ts";

export {
  addWorkspaceMemberToChannelForActorSync,
  acceptChannelInvitationForActorSync,
  approveChannelAccessRequestForActorSync,
  assertCanReadChannelForActorSync,
  assertCanWriteChannelForActorSync,
  canReadDirectChannelForActorSync,
  canReadChannelForActorSync,
  canWriteChannelForActorSync,
  createChannelParticipantsForMembersSync,
  getChannelAccessSummaryForActorSync,
  inviteUserToChannelForActorSync,
  listChannelAccessRequestsForManagerSync,
  listChannelInvitationsForActorSync,
  rejectChannelInvitationForActorSync,
  rejectChannelAccessRequestForActorSync,
  removeWorkspaceMemberFromChannelForActorSync,
  requestChannelAccessForActorSync,
  revokeChannelInvitationForActorSync,
  type ChannelAccessActor,
  type ChannelAccessState,
  type ChannelAccessSummary,
} from "../channel-access/channel-access.ts";

export {
  postHumanDirectSystemMessageSync,
  resolveHumanDirectChannelForUsersSync,
  sendContactMessageSync,
  sendContactMessageWithAttachmentsSync,
  sendContactMessageForHumanWithAttachmentsSync,
  sendHumanDirectMessageSync,
  upsertDirectConversationStateSync,
} from "../contacts/contacts.ts";
