// 多会话拆分服务层 barrel（docs/0820/session-split）。
export {
  archiveConversationForUserSync,
  createConversationForUserSync,
  listConversationsForChannelForUserSync,
  listConversationsForEmployeeForUserSync,
  readConversationForUserSync,
  resolveConversationLaneForSendSync,
  unarchiveConversationForUserSync,
  updateConversationSummaryForUserSync,
  type CreateConversationForUserInput,
  type CreateConversationForUserResult,
  type ListConversationsForChannelForUserInput,
  type ListConversationsForUserInput,
  type ReadConversationForUserInput,
  type ResolveConversationLaneForSendInput,
  type UpdateConversationSummaryForUserInput,
} from "./conversations.ts";
