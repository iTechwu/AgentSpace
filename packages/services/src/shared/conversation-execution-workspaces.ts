import type {
  DofeAgentState,
  ConversationAutoContinuationState,
  ConversationExecutionWorkspaceState,
} from "@dofe-agent/domain/workspace";
import { getDaemonChannelWorkDirPath, getLocalDaemonStateDirPath } from "@dofe-agent/db";
import { sameValue } from "./helpers.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "./state-io.ts";

export function buildConversationExecutionWorkspaceKey(input: {
  conversationKind?: "direct" | "group";
  channelName: string;
  agentId: string;
  conversationId?: string;
}): string {
  const kind = input.conversationKind ?? "group";
  const base = `${kind}:${input.channelName}:${input.agentId}`;
  // 会话拆分（docs/0820）：有 conversationId 时按会话隔离 Lane 级状态（lastTaskQueueId/
  // sessionId/workDir/autoContinuation），避免同员工多会话互相覆盖；无 conversationId 保持 legacy 频道级键。
  return input.conversationId ? `${base}:${input.conversationId}` : base;
}

export function resolveConversationExecutionWorkspacePath(input: {
  workspaceId: string;
  channelName: string;
  agentId: string;
}): string {
  return getDaemonChannelWorkDirPath(getLocalDaemonStateDirPath(), {
    workspaceId: input.workspaceId,
    threadId: input.channelName,
    agentId: input.agentId,
  });
}

export function resolveConversationExecutionResume(input: {
  startNewConversation?: boolean;
  existing?: Pick<ConversationExecutionWorkspaceState, "sessionId" | "workDir">;
  latest?: { sessionId?: string; workDir?: string } | null;
}): { sessionId?: string; workDir?: string } {
  return {
    sessionId: input.startNewConversation
      ? undefined
      : (input.existing?.sessionId ?? input.latest?.sessionId),
    workDir: input.existing?.workDir ?? input.latest?.workDir,
  };
}

export function readConversationExecutionWorkspaceState(
  state: DofeAgentState,
  input: {
    channelName: string;
    agentId: string;
    contactId?: string;
    conversationId?: string;
  },
): ConversationExecutionWorkspaceState | undefined {
  const conversationKey = buildConversationExecutionWorkspaceKey({
    conversationKind: input.contactId ? "direct" : "group",
    channelName: input.channelName,
    agentId: input.agentId,
    conversationId: input.conversationId,
  });
  const existing = state.conversationExecutionWorkspaces?.find((workspace) => workspace.conversationKey === conversationKey);
  if (existing) {
    return existing;
  }

  // 会话作用域不继承 legacy 频道级 direct conversation 状态（session/workDir 冷重建）。
  if (input.conversationId) {
    return undefined;
  }

  const contactId = input.contactId;
  if (!contactId) {
    return undefined;
  }

  const legacyDirectConversation = state.directConversations.find((conversation) => sameValue(conversation.contactId, contactId));
  if (!legacyDirectConversation) {
    return undefined;
  }

  return {
    conversationKey,
    conversationKind: "direct",
    channelName: input.channelName,
    agentId: input.agentId,
    contactId,
    humanMemberName: legacyDirectConversation.humanMemberName,
    updatedAt: legacyDirectConversation.updatedAt,
    sessionId: legacyDirectConversation.sessionId,
    workDir: legacyDirectConversation.workDir,
  };
}

export function upsertConversationExecutionWorkspaceState(
  state: DofeAgentState,
  input: {
    channelName: string;
    agentId: string;
    contactId?: string;
    conversationId?: string;
    humanMemberName?: string;
    sessionId?: string | null;
    workDir?: string | null;
    lastTaskQueueId?: string;
    lastError?: string | null;
    autoContinuation?: ConversationAutoContinuationState | null;
    updatedAt?: string;
  },
): ConversationExecutionWorkspaceState {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const conversationKey = buildConversationExecutionWorkspaceKey({
    conversationKind: input.contactId ? "direct" : "group",
    channelName: input.channelName,
    agentId: input.agentId,
    conversationId: input.conversationId,
  });
  const conversationKind = input.contactId ? "direct" : "group";
  const currentList = state.conversationExecutionWorkspaces ?? [];
  const existingIndex = currentList.findIndex((workspace) => workspace.conversationKey === conversationKey);
  const existing = existingIndex >= 0 ? currentList[existingIndex] : undefined;

  const nextWorkspace: ConversationExecutionWorkspaceState = {
    conversationKey,
    conversationKind,
    channelName: input.channelName,
    agentId: input.agentId,
    conversationId: input.conversationId ?? existing?.conversationId,
    contactId: input.contactId ?? existing?.contactId,
    humanMemberName: input.humanMemberName ?? existing?.humanMemberName,
    updatedAt,
    lastTaskQueueId: input.lastTaskQueueId ?? existing?.lastTaskQueueId,
    sessionId: input.sessionId === null ? undefined : (input.sessionId ?? existing?.sessionId),
    workDir: input.workDir === null ? undefined : (input.workDir ?? existing?.workDir),
    lastError: input.lastError === null ? undefined : (input.lastError ?? existing?.lastError),
    autoContinuation:
      input.autoContinuation === null
        ? undefined
        : (input.autoContinuation ?? existing?.autoContinuation),
  };

  const nextList = currentList.filter((workspace) => workspace.conversationKey !== conversationKey);
  nextList.unshift(nextWorkspace);
  state.conversationExecutionWorkspaces = nextList;
  return nextWorkspace;
}

export function writeConversationExecutionWorkspaceStateSync(
  input: Parameters<typeof upsertConversationExecutionWorkspaceState>[1],
  workspaceId?: string,
  stateArg?: DofeAgentState,
): DofeAgentState {
  const state = stateArg ?? ensureWorkspaceStateSync(workspaceId);
  upsertConversationExecutionWorkspaceState(state, input);
  return stateArg ? state : writeWorkspaceStateSync(state, workspaceId);
}
