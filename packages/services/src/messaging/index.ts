// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/messaging` 子路径与根 re-export 使用。

export {
  completeAgentChannelReplySync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  parseChannelMentionsSync,
  postMessageSync,
  sendChannelHumanMessageSync,
  replacePendingChannelMessageSync,
  recordAgentChannelProgressSync,
  updatePendingAgentChannelReplySync,
  pinMessageSync,
  unpinMessageSync,
  acknowledgeMessageSync,
} from "../messages/messages.ts";

export {
  setSessionModelOverrideForChatCommandSync,
  validateSessionModelOverrideForChatCommandAsync,
  readSessionModelOverrideForChatSync,
  resolveChatModelOverrideAsync,
  ChatModelOverrideValidationError,
  type SetSessionModelOverrideForChatInput,
  type SetSessionModelOverrideForChatResult,
  type ResolveChatModelOverrideInput,
  type ChatModelOverrideInfo,
} from "../chat/model-override.ts";

export {
  publishChannelMessageCreatedEvent,
  publishChannelThreadChangedEvent,
  publishOpenMontageJobChangedEvent,
  subscribeWorkspaceRealtimeEvents,
  type WorkspaceRealtimeEvent,
  type WorkspaceRealtimeListener,
} from "../realtime/events.ts";
