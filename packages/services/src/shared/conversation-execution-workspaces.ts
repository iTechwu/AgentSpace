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
}): string {
  const kind = input.conversationKind ?? "group";
  return `${kind}:${input.channelName}:${input.agentId}`;
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

export function readConversationExecutionWorkspaceState(
  state: DofeAgentState,
  input: {
    channelName: string;
    agentId: string;
    contactId?: string;
  },
): ConversationExecutionWorkspaceState | undefined {
  const conversationKey = buildConversationExecutionWorkspaceKey({
    conversationKind: input.contactId ? "direct" : "group",
    channelName: input.channelName,
    agentId: input.agentId,
  });
  const existing = state.conversationExecutionWorkspaces?.find((workspace) => workspace.conversationKey === conversationKey);
  if (existing) {
    return existing;
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
