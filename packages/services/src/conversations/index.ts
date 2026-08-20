// 多会话拆分服务层 barrel（docs/0820/session-split）。
export {
  archiveConversationForUserSync,
  createConversationForUserSync,
  listConversationsForEmployeeForUserSync,
  readConversationForUserSync,
  resolveConversationLaneForSendSync,
  unarchiveConversationForUserSync,
  updateConversationSummaryForUserSync,
  type CreateConversationForUserInput,
  type CreateConversationForUserResult,
  type ListConversationsForUserInput,
  type ReadConversationForUserInput,
  type ResolveConversationLaneForSendInput,
  type UpdateConversationSummaryForUserInput,
} from "./conversations.ts";
