import {
  buildTaskQueueId,
  DEFAULT_WORKSPACE_ID,
  ensureExecutionLaneForConversationSync,
  enqueueNativeTaskSync,
  listQueuedTasksSync,
  readLatestChannelExecutionSync,
  readQueuedTaskSync,
  resolveStoredEmployeeIdSync,
} from "@dofe-agent/db";
import type {
  DofeAgentState,
  MessageAttachment,
  MessageMention,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import { parseAgentMentions, parseMentionPlan, type MentionCandidate } from "@dofe-agent/domain";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import {
  readConversationExecutionWorkspaceState,
  resolveConversationExecutionResume,
  resolveConversationExecutionWorkspacePath,
  upsertConversationExecutionWorkspaceState,
} from "../shared/conversation-execution-workspaces.ts";
import { sameValue } from "../shared/helpers.ts";
import { resolveChannelHumanMemberNames } from "../shared/channel-members.ts";
import {
  pushWorkspaceMessageToChannel,
  applyWorkspaceDataPolicyToExternalMessageInput,
  assertWorkspaceDataPolicyAllowsExternalMessageInput,
  buildExternalMessageData,
  buildChannelHistorySnapshot,
  buildConversationHistorySnapshot,
  buildMentionCandidates,
  enqueueChannelMentionStepSync,
  getChannelHistoryFilePath,
  postMessageSync as postMessageSyncShared,
  toTaskPayloadAttachment,
  type ExternalMessageInputContext,
} from "../shared/messaging.ts";
import {
  createAutoContinuationState,
  parseAutoContinuationDirective,
} from "../automations/auto-continuation.ts";
import {
  createChannelDocumentRun,
  listChannelDocumentRunSteps,
} from "../documents/runs.ts";
import {
  assertCanUseBoundEmployeeRuntimeInChannelForActorSync,
  assertCanUseEmployeeInChannelForActorSync,
} from "../runtime-access/runtime-access.ts";
import { canReadChannelForActorSync } from "../channel-access/channel-access.ts";
import {
  publishChannelMessageCreatedEvent,
  publishChannelThreadChangedEvent,
} from "../realtime/events.ts";

const RUNTIME_COORDINATOR = "系统提示";
const DOC_COORDINATOR = "系统提示";
const AUTO_CONTINUATION_COORDINATOR = "系统提示";
const AGENT_OUTPUT_MENTION_MAX_DISPATCHES = 3;
const AGENT_OUTPUT_MENTION_MAX_CASCADE_DEPTH = 2;
const AGENT_OUTPUT_MENTION_MAX_ROOT_TASKS = 6;

type AgentMessageMention = Extract<MessageMention, { mentionType: "agent" }>;
type HumanMessageMention = Extract<MessageMention, { mentionType: "human" }>;

interface ParsedHumanMention {
  humanId: string;
  label: string;
  token: string;
  mentionType: "human";
  inChannel: boolean;
}

export interface ChannelMentionParseResult {
  agentMentions: AgentMessageMention[];
  humanMentions: HumanMessageMention[];
  unknownMentions: string[];
  outOfChannelAgentMentions: AgentMessageMention[];
  outOfChannelHumanMentions: HumanMessageMention[];
  allMentions: MessageMention[];
}

export interface CompleteAgentChannelReplyResult {
  state: DofeAgentState;
  message: WorkspaceMessage;
  created: boolean;
  warnings: string[];
  queuedTaskIds: string[];
  dispatchedAgentIds: string[];
}

export function formatConversationFailureSummary(input: {
  agentName: string;
  channelName: string;
  errorText: string;
  isDirectConversation?: boolean;
}): string {
  const label = input.isDirectConversation ? "私聊" : "群聊";
  return `${input.agentName} 在${label} ${input.channelName} 中执行失败：${formatUserFacingTaskFailure(input.errorText)}`;
}

export function formatTaskFailureSummary(input: {
  title: string;
  errorText: string;
}): string {
  return `任务 ${input.title} 执行失败：${formatUserFacingTaskFailure(input.errorText)}`;
}

export function pinMessageSync(messageId: string, workspaceId?: string, actorName?: string, actorUserId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const message = state.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new Error(`Message "${messageId}" not found.`);
  }
  assertHumanCanAccessMessageChannel(state, message.channel, actorName, actorUserId, effectiveWorkspaceId);
  const updated: typeof message = {
    ...message,
    pinned: true,
    pinnedAt: new Date().toISOString(),
  };
  state.messages = state.messages.map((m) => (m.id === messageId ? updated : m));
  return writeWorkspaceStateSync(state, workspaceId);
}

export function unpinMessageSync(messageId: string, workspaceId?: string, actorName?: string, actorUserId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const message = state.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new Error(`Message "${messageId}" not found.`);
  }
  assertHumanCanAccessMessageChannel(state, message.channel, actorName, actorUserId, effectiveWorkspaceId);
  const updated: typeof message = {
    ...message,
    pinned: undefined,
    pinnedAt: undefined,
  };
  state.messages = state.messages.map((m) => (m.id === messageId ? updated : m));
  return writeWorkspaceStateSync(state, workspaceId);
}

export function acknowledgeMessageSync(
  messageId: string,
  workspaceId?: string,
  actorName?: string,
  actorUserId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const message = state.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new Error(`Message "${messageId}" not found.`);
  }
  assertHumanCanAccessMessageChannel(state, message.channel, actorName, actorUserId, effectiveWorkspaceId);

  const label = actorName?.trim() || "你";
  const existing = message.acknowledgements ?? [];
  const alreadyAcknowledged = existing.some((acknowledgement) =>
    actorUserId
      ? acknowledgement.userId === actorUserId
      : sameValue(acknowledgement.label, label),
  );
  if (alreadyAcknowledged) {
    return state;
  }

  const updated: typeof message = {
    ...message,
    acknowledgements: [
      ...existing,
      {
        userId: actorUserId,
        label,
        acknowledgedAt: new Date().toISOString(),
      },
    ],
  };
  state.messages = state.messages.map((m) => (m.id === messageId ? updated : m));
  return writeWorkspaceStateSync(state, workspaceId);
}

export const postMessageSync: typeof postMessageSyncShared = postMessageSyncShared;

export function parseChannelMentionsSync(
  state: DofeAgentState,
  channelName: string,
  summary: string,
): ChannelMentionParseResult {
  const agentMentionParse = parseAgentMentions(summary, buildMentionCandidates(state, channelName));
  const humanMentionParse = parseHumanMentions(summary, buildHumanMentionCandidates(state, channelName));
  const humanMentions = humanMentionParse.mentions.filter(
    (mention) => !agentMentionParse.mentions.some((agentMention) => sameValue(agentMention.token, mention.token)),
  );
  const agentMentions: AgentMessageMention[] = agentMentionParse.mentions.map((mention) => ({
    agentId: mention.agentId,
    label: mention.label,
    token: mention.token,
    mentionType: "agent" as const,
    inChannel: mention.inChannel,
  }));
  const unknownMentions = agentMentionParse.unknownMentions.filter(
    (token) => !humanMentionParse.mentions.some((mention) => sameValue(mention.token, token)),
  );
  const inChannelAgentMentions = agentMentions.filter((mention) => mention.inChannel);
  const inChannelHumanMentions = humanMentions.filter((mention) => mention.inChannel);

  return {
    agentMentions: inChannelAgentMentions,
    humanMentions: inChannelHumanMentions,
    unknownMentions,
    outOfChannelAgentMentions: agentMentions.filter((mention) => !mention.inChannel),
    outOfChannelHumanMentions: humanMentions.filter((mention) => !mention.inChannel),
    allMentions: [...inChannelAgentMentions, ...inChannelHumanMentions],
  };
}

export function sendChannelHumanMessageSync(
  channelName: string,
  speaker: string,
  summary: string,
  attachments?: MessageAttachment[],
  replyToMessageId?: string,
  workspaceId?: string,
  requesterUserId?: string,
  externalInput?: ExternalMessageInputContext,
  executionOptions?: { startNewConversation?: boolean; conversationId?: string; executionLaneId?: string; idempotencyKey?: string },
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (!channel) {
    throw new Error(`Channel "${channelName}" does not exist.`);
  }

  const trimmed = summary.trim();
  if (!trimmed) {
    throw new Error("Message content is required.");
  }
  const governedExternalInput = applyWorkspaceDataPolicyToExternalMessageInput(externalInput, effectiveWorkspaceId, {
    hasAttachments: Boolean(attachments && attachments.length > 0),
  });
  assertWorkspaceDataPolicyAllowsExternalMessageInput(governedExternalInput);
  assertHumanCanAccessChannel(state, channel.name, speaker, requesterUserId, effectiveWorkspaceId, governedExternalInput);

  const mentionCandidates = buildMentionCandidates(state, channel.name);
  const mentionParse = parseChannelMentionsSync(state, channel.name, trimmed);
  if (mentionParse.outOfChannelAgentMentions.length > 0) {
    throw new Error(`以下 Agent 不在当前群组中：${mentionParse.outOfChannelAgentMentions.map((mention) => `@${mention.token}`).join("、")}。`);
  }
  if (mentionParse.outOfChannelHumanMentions.length > 0) {
    throw new Error(`以下成员不在当前群组中：${mentionParse.outOfChannelHumanMentions.map((mention) => `@${mention.token}`).join("、")}。`);
  }
  if (mentionParse.unknownMentions.length > 0) {
    throw new Error(`未找到可用成员或 Agent：${mentionParse.unknownMentions.map((token) => `@${token}`).join("、")}。`);
  }
  const mentionPlan = parseMentionPlan(trimmed, mentionCandidates);
  const autoContinuationDirective =
    mentionParse.agentMentions.length === 1 ? parseAutoContinuationDirective(trimmed) : null;

  // 幂等：同一 Idempotency-Key 的重试不重复写入用户消息（任务已按确定性 ID 去重，见 task-queue）。
  if (
    executionOptions?.idempotencyKey
    && readQueuedTaskSync(buildTaskQueueId(effectiveWorkspaceId, executionOptions.idempotencyKey))
  ) {
    return state;
  }

  const humanMessage = pushWorkspaceMessageToChannel(state, channel.name, {
    speaker,
    speakerUserId: requesterUserId,
    role: "human",
    summary: trimmed,
    status: "completed",
    attachments,
    mentions: mentionParse.allMentions,
    replyToMessageId,
    conversationId: executionOptions?.conversationId,
    data: buildExternalMessageData(governedExternalInput),
  }, effectiveWorkspaceId);

  if (mentionParse.agentMentions.length === 0) {
    state.ledger.unshift({
      title: "Channel message",
      note: `${speaker} sent a regular message in ${channel.name} without triggering any agent.`,
    });

    return writeChannelMessageStateAndPublish(state, effectiveWorkspaceId, channel.name, humanMessage.id, humanMessage.time);
  }

  if (mentionPlan.mode === "parallel" && mentionPlan.warnings.length > 0) {
    pushWorkspaceMessageToChannel(state, channel.name, {
      speaker: DOC_COORDINATOR,
      role: "agent",
      summary: "Unable to infer a safe handoff order. Please rewrite the message with explicit sequencing such as \u201c@A ... 然后 @B ...\u201d。",
      code: "channel_document.plan_ambiguous_notice",
      data: {
        channel_name: channel.name,
      },
      status: "error",
    }, effectiveWorkspaceId);
    state.ledger.unshift({
      title: "Channel document workflow ambiguous",
      note: `${speaker} 在 ${channel.name} 发起的多 agent 协作表达顺序不明确，系统要求改写。`,
      code: "channel_document.run_ambiguous",
      data: {
        channel_name: channel.name,
      },
    });
    return writeChannelMessageStateAndPublish(state, effectiveWorkspaceId, channel.name, humanMessage.id, humanMessage.time);
  }

  if (mentionPlan.mode === "sequential" && mentionPlan.steps.length > 1) {
    // Preflight every step before creating or enqueueing the run. This keeps
    // an unauthorized later handoff from leaving earlier steps queued.
    for (const step of mentionPlan.steps) {
      assertCanDispatchMentionedEmployee({
        state,
        workspaceId: effectiveWorkspaceId,
        channelName: channel.name,
        employeeName: step.agentId,
        actorUserId: requesterUserId,
        actorDisplayName: speaker,
      });
    }

    const { run, steps } = createChannelDocumentRun({
      state,
      channelName: channel.name,
      sourceMessageId: humanMessage.id,
      sourceSummary: trimmed,
      plan: mentionPlan,
    });

    let queuedCount = 0;
    const unavailableAgents: string[] = [];
    for (const step of steps.filter((item) => item.status === "ready")) {
      const queued = enqueueChannelMentionStepSync(state, {
        channelName: channel.name,
        sourceMessage: humanMessage,
        fullMessage: trimmed,
        attachments,
        step,
        mentionedAgentIds: mentionParse.agentMentions.map((item) => item.agentId),
        mentionedAgentLabels: mentionParse.agentMentions.map((item) => item.label),
        workspaceId: effectiveWorkspaceId,
        requesterUserId,
        requesterDisplayName: speaker,
        externalInput: governedExternalInput,
        startNewConversation: executionOptions?.startNewConversation,
        historyFromMessageId: executionOptions?.startNewConversation ? humanMessage.id : undefined,
        conversationId: executionOptions?.conversationId,
        executionLaneId: executionOptions?.executionLaneId,
      });

      if (queued) {
        queuedCount += 1;
        continue;
      }

      unavailableAgents.push(step.agentLabel);
      step.status = "blocked";
      step.updatedAt = new Date().toISOString();
    }

    if (unavailableAgents.length > 0) {
      pushWorkspaceMessageToChannel(state, channel.name, {
        speaker: RUNTIME_COORDINATOR,
        role: "agent",
        summary: `${unavailableAgents.join(", ")} does not have an executable runtime bound and cannot start the document handoff flow.`,
        code: "mention.unavailable",
        data: { agent_names: unavailableAgents.join("、") },
        status: "error",
      }, effectiveWorkspaceId);
    }

    state.ledger.unshift({
      title: "Channel document run",
      note: `${speaker} 在 ${channel.name} 发起了一条串行协作文档流程，共 ${steps.length} 步。`,
      code: "channel_document.run_created",
      data: {
        channel_name: channel.name,
        run_id: run.id,
        step_count: String(steps.length),
      },
    });
    pushWorkspaceMessageToChannel(state, channel.name, {
      speaker: DOC_COORDINATOR,
      role: "agent",
      summary: `Document workflow started with ${steps.length} step(s).`,
      code: "channel_document.run_created_notice",
      data: {
        channel_name: channel.name,
        run_id: run.id,
        step_count: String(steps.length),
      },
    }, effectiveWorkspaceId);

    return writeChannelMessageStateAndPublish(state, effectiveWorkspaceId, channel.name, humanMessage.id, humanMessage.time);
  }

  let queuedCount = 0;
  const unavailableAgents: string[] = [];
  for (const mention of mentionParse.agentMentions) {
    const agent = state.activeEmployees.find((employee) => sameValue(employee.name, mention.agentId));
    if (!agent) {
      continue;
    }
    assertCanDispatchMentionedEmployee({
      state,
      workspaceId: effectiveWorkspaceId,
      employeeName: agent.name,
      channelName: channel.name,
      actorUserId: requesterUserId,
      actorDisplayName: speaker,
    });

    const existingExecutionWorkspace = readConversationExecutionWorkspaceState(state, {
      channelName: channel.name,
      agentId: agent.name,
      conversationId: executionOptions?.conversationId,
    });
    const lastExecution = readLatestChannelExecutionSync(agent.name, channel.name, effectiveWorkspaceId);
    const { sessionId: resumedSessionId, workDir: resumedWorkDir } = resolveConversationExecutionResume({
      startNewConversation: executionOptions?.startNewConversation,
      existing: existingExecutionWorkspace,
      latest: lastExecution,
    });
    const autoContinuation = autoContinuationDirective
      ? createAutoContinuationState({
          directive: autoContinuationDirective,
          requestedByUserId: requesterUserId,
          requestedByDisplayName: speaker,
          sourceMessageId: humanMessage.id,
        })
      : undefined;
    // 群聊多 Lane：有 conversationId 时，按被提及 employee 各自解析/建立 Lane（docs §2.3）。
    let mentionLaneId = executionOptions?.executionLaneId;
    if (executionOptions?.conversationId) {
      const mentionedEmployeeId = resolveStoredEmployeeIdSync(agent.name, effectiveWorkspaceId);
      if (mentionedEmployeeId) {
        const mentionLane = ensureExecutionLaneForConversationSync({
          workspaceId: effectiveWorkspaceId,
          conversationId: executionOptions.conversationId,
          employeeId: mentionedEmployeeId,
          employeeName: agent.name,
          kind: "group",
          channelId: channel.name,
        });
        mentionLaneId = mentionLane.id;
      }
    }
    const queued = enqueueNativeTaskSync({
      workspaceId: effectiveWorkspaceId,
      assignee: agent.name,
      title: `@提及 · ${channel.name} · ${mention.label}`,
      channel: channel.name,
      priority: "medium",
      triggerType: "mention_chat",
      requestedByUserId: requesterUserId,
      requestedByDisplayName: speaker,
      conversationId: executionOptions?.conversationId,
      executionLaneId: mentionLaneId,
      idempotencyKey: executionOptions?.idempotencyKey,
      metadata: {
        sourceChannel: channel.name,
        sourceMessageId: humanMessage.id,
        mentionType: "agent",
        mentionedAgentIds: mentionParse.agentMentions.map((item) => item.agentId),
        mentionedAgentLabels: mentionParse.agentMentions.map((item) => item.label),
        assigneeMentionToken: mention.token,
        channelName: channel.name,
        channelMessage: trimmed,
        channelHistory: executionOptions?.conversationId
          ? buildConversationHistorySnapshot(state, channel.name, executionOptions.conversationId)
          : buildChannelHistorySnapshot(
              state,
              channel.name,
              executionOptions?.startNewConversation ? humanMessage.id : undefined,
            ),
        channelHistoryPath: executionOptions?.conversationId || executionOptions?.startNewConversation
          ? undefined
          : getChannelHistoryFilePath(channel.name, effectiveWorkspaceId),
        channelSessionId: executionOptions?.conversationId ? undefined : resumedSessionId,
        ...(governedExternalInput ? { externalInput: governedExternalInput } : {}),
        autoContinuation,
        attachments:
          attachments?.map(toTaskPayloadAttachment) ?? [],
      },
    });

    if (queued) {
      queuedCount += 1;
      const mentionConversationScoped = Boolean(executionOptions?.conversationId);
      upsertConversationExecutionWorkspaceState(state, {
        channelName: channel.name,
        agentId: agent.name,
        conversationId: executionOptions?.conversationId,
        sessionId: mentionConversationScoped || executionOptions?.startNewConversation ? null : resumedSessionId,
        workDir: mentionConversationScoped
          ? null
          : (resumedWorkDir ?? resolveConversationExecutionWorkspacePath({
              workspaceId: effectiveWorkspaceId,
              channelName: channel.name,
              agentId: agent.name,
            })),
        lastTaskQueueId: queued.id,
        lastError: null,
        autoContinuation,
      });
      if (autoContinuation) {
        state.ledger.unshift({
          title: "Auto continuation started",
          note: `${speaker} 在 ${channel.name} 要求 ${agent.name} 自动续跑到 ${autoContinuation.until}。`,
          code: "auto_continuation.started",
          data: {
            channel_name: channel.name,
            agent_name: agent.name,
            until: autoContinuation.until,
            source_message_id: humanMessage.id,
          },
        });
        pushWorkspaceMessageToChannel(state, channel.name, {
          speaker: AUTO_CONTINUATION_COORDINATOR,
          role: "agent",
          summary: `Auto continuation started for ${agent.name} until ${autoContinuation.until}.`,
          code: "auto_continuation.started_notice",
          data: {
            channel_name: channel.name,
            agent_name: agent.name,
            until: autoContinuation.until,
            source_message_id: humanMessage.id,
          },
        }, effectiveWorkspaceId);
      }
      pushWorkspaceMessageToChannel(state, channel.name, {
        speaker: agent.name,
        role: "agent",
        summary: "Thinking",
        code: "agent.pending",
        conversationId: executionOptions?.conversationId,
        data: {
          agent_name: agent.name,
          source_message_id: humanMessage.id,
          source_task_queue_id: queued.id,
        },
        status: "pending",
      }, effectiveWorkspaceId);
      continue;
    }

    unavailableAgents.push(mention.label);
  }

  if (unavailableAgents.length > 0) {
    pushWorkspaceMessageToChannel(state, channel.name, {
      speaker: RUNTIME_COORDINATOR,
      role: "agent",
      summary: `${unavailableAgents.join(", ")} does not have an executable runtime bound and cannot respond to this mention.`,
      code: "mention.unavailable",
      data: { agent_names: unavailableAgents.join("、") },
      status: "error",
    }, effectiveWorkspaceId);
  }

  state.ledger.unshift({
    title: "Channel mention",
    note:
      queuedCount > 0
        ? `${speaker} directly mentioned ${mentionParse.agentMentions.map((item) => item.label).join(", ")} in ${channel.name}, dispatching ${queuedCount} agent(s).`
        : `${speaker} mentioned ${mentionParse.agentMentions.map((item) => item.label).join(", ")} in ${channel.name}, but the target agent is not executable right now.`,
  });

  return writeChannelMessageStateAndPublish(state, effectiveWorkspaceId, channel.name, humanMessage.id, humanMessage.time);
}

function buildHumanMentionCandidates(state: DofeAgentState, channelName: string): MentionCandidate[] {
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  const channelHumanNames = channel ? resolveChannelHumanMemberNames(state, channel) : [];
  const names = uniqueNames([
    ...state.humanMembers.map((member) => member.name),
    ...state.channels.flatMap((item) => resolveChannelHumanMemberNames(state, item)),
  ]);

  return names.map((name) => ({
    agentId: `human:${name}`,
    label: name,
    aliases: [name],
    inChannel: channelHumanNames.some((memberName) => sameValue(memberName, name)),
  }));
}

function parseHumanMentions(
  input: string,
  candidates: MentionCandidate[],
): { mentions: ParsedHumanMention[] } {
  const parsed = parseAgentMentions(input, candidates);
  return {
    mentions: parsed.mentions.map((mention) => ({
      humanId: mention.agentId.replace(/^human:/, ""),
      label: mention.label,
      token: mention.token,
      mentionType: "human",
      inChannel: mention.inChannel,
    })),
  };
}

function uniqueNames(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || result.some((existing) => sameValue(existing, trimmed))) {
      continue;
    }
    result.push(trimmed);
  }
  return result;
}

function assertCanDispatchMentionedEmployee(input: {
  state: DofeAgentState;
  workspaceId: string;
  employeeName: string;
  channelName: string;
  actorUserId?: string;
  actorDisplayName: string;
}): void {
  if (!input.actorUserId) {
    return;
  }
  assertCanUseEmployeeInChannelForActorSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    channelName: input.channelName,
    actorUserId: input.actorUserId,
    actorDisplayName: input.actorDisplayName,
  });
  assertCanUseBoundEmployeeRuntimeInChannelForActorSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
    channelName: input.channelName,
    actorUserId: input.actorUserId,
    actorDisplayName: input.actorDisplayName,
  });
}

function assertHumanCanAccessMessageChannel(
  state: DofeAgentState,
  channelName: string | undefined,
  actorName: string | undefined,
  actorUserId?: string,
  workspaceId?: string,
): void {
  if (!actorName || !channelName) {
    return;
  }
  assertHumanCanAccessChannel(state, channelName, actorName, actorUserId, workspaceId);
}

function assertHumanCanAccessChannel(
  state: DofeAgentState,
  channelName: string,
  actorName: string,
  actorUserId?: string,
  workspaceId?: string,
  externalInput?: ExternalMessageInputContext,
): void {
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (!channel) {
    throw new Error(`Channel "${channelName}" does not exist.`);
  }
  if (isExternalGuestChannelContextActor(externalInput)) {
    return;
  }
  if (
    actorUserId &&
    canReadChannelForActorSync({
      workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelName,
      actor: { userId: actorUserId, displayName: actorName },
    })
  ) {
    return;
  }
  const visibleHumanNames = resolveChannelHumanMemberNames(state, channel);
  if (visibleHumanNames.some((name) => sameValue(name, actorName))) {
    return;
  }
  throw new Error(`Human member "${actorName}" does not belong to channel "${channelName}".`);
}

function isExternalGuestChannelContextActor(input: ExternalMessageInputContext | undefined): boolean {
  const actor = input?.actor;
  return actor?.actorType === "external_guest" &&
    !actor.userId &&
    typeof actor.externalActorReference === "string" &&
    actor.externalActorReference.trim().length > 0 &&
    (actor.externalGuestPermissionProfile === "channel_context_only" ||
      actor.externalGuestPermissionProfile === "channel_readonly");
}

export function completeAgentChannelReplySync(input: {
  channel: string;
  pendingSpeaker?: string;
  speaker: string;
  conversationId?: string;
  summary: string;
  attachments?: MessageAttachment[];
  sourceTaskQueueId?: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  mentionCascadeDepth?: number;
  mentionRootMessageId?: string;
  sessionId?: string;
  workDir?: string;
}, workspaceId?: string): CompleteAgentChannelReplyResult {
  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const channel = state.channels.find((item) => sameValue(item.name, input.channel));
  if (!channel) {
    throw new Error(`Channel "${input.channel}" does not exist.`);
  }

  const sourceTaskQueueId = input.sourceTaskQueueId?.trim();
  const existingMessage = sourceTaskQueueId
    ? state.messages.find((message) =>
        sameValue(message.channel ?? "", channel.name) &&
        message.role === "agent" &&
        message.status === "completed" &&
        message.kind !== "process" &&
        message.data?.source_task_queue_id === sourceTaskQueueId,
      )
    : undefined;
  if (existingMessage) {
    return {
      state,
      message: existingMessage,
      created: false,
      warnings: [],
      queuedTaskIds: [],
      dispatchedAgentIds: [],
    };
  }

  if (input.pendingSpeaker?.trim()) {
    const pendingReplies = state.messages.filter((message) =>
      sameValue(message.channel ?? "", channel.name) &&
      message.role === "agent" &&
      message.status === "pending" &&
      message.kind !== "process",
    );
    const taskBoundReplies = sourceTaskQueueId
      ? pendingReplies.filter((message) => message.data?.source_task_queue_id === sourceTaskQueueId)
      : [];
    const legacySpeakerReplies = pendingReplies.filter((message) =>
      sameValue(message.speaker, input.pendingSpeaker ?? ""),
    );
    // During a rolling deployment, existing pending bubbles have no task ID. Remove a
    // legacy bubble only when it is unambiguous; task-bound bubbles are always exact.
    const repliesToReplace = taskBoundReplies.length > 0
      ? taskBoundReplies
      : sourceTaskQueueId && legacySpeakerReplies.length === 1
        ? legacySpeakerReplies
        : !sourceTaskQueueId
          ? legacySpeakerReplies
          : [];
    const replyIdsToReplace = new Set(repliesToReplace.map((message) => message.id));
    state.messages = state.messages.filter((message) => !replyIdsToReplace.has(message.id));
    if (sourceTaskQueueId) {
      state.messages = state.messages.map((message) =>
        message.kind === "process" &&
        message.status === "pending" &&
        message.data?.source_task_queue_id === sourceTaskQueueId
          ? { ...message, status: "completed" }
          : message,
      );
    }
  }

  const shouldProcessMentions = channel.kind !== "direct";
  const mentionParse = shouldProcessMentions
    ? parseChannelMentionsSync(state, channel.name, input.summary)
    : emptyChannelMentionParseResult();
  const warnings = shouldProcessMentions ? buildAgentOutputMentionParseWarnings(mentionParse) : [];
  const message = pushWorkspaceMessageToChannel(state, channel.name, {
    speaker: input.speaker,
    role: "agent",
    summary: input.summary,
    status: "completed",
    attachments: input.attachments,
    mentions: mentionParse.allMentions,
    conversationId: input.conversationId,
    ...(sourceTaskQueueId ? { data: { source_task_queue_id: sourceTaskQueueId } } : {}),
  }, effectiveWorkspaceId);

  const dispatchResult = shouldProcessMentions
    ? dispatchAgentOutputMentionsSync(state, {
        channelName: channel.name,
        sourceMessage: message,
        sourceTaskQueueId: input.sourceTaskQueueId,
        initiatorAgentId: input.speaker,
        agentMentions: mentionParse.agentMentions,
        workspaceId: effectiveWorkspaceId,
        requestedByUserId: input.requestedByUserId,
        requestedByDisplayName: input.requestedByDisplayName,
        mentionCascadeDepth: input.mentionCascadeDepth,
        mentionRootMessageId: input.mentionRootMessageId,
        sessionId: input.sessionId,
        workDir: input.workDir,
      })
    : { queuedTaskIds: [], dispatchedAgentIds: [], warnings: [] };
  warnings.push(...dispatchResult.warnings);

  if (warnings.length > 0 || dispatchResult.queuedTaskIds.length > 0) {
    state.ledger.unshift({
      title: "Agent output mentions",
      note:
        dispatchResult.queuedTaskIds.length > 0
          ? `${input.speaker} mentioned ${mentionParse.agentMentions.map((mention) => mention.label).join(", ")} in ${channel.name}, dispatching ${dispatchResult.queuedTaskIds.length} agent(s).`
          : `${input.speaker} mentioned channel participants in ${channel.name}; no follow-up agent task was dispatched.`,
      code: "agent_output_mentions.processed",
      data: {
        channel_name: channel.name,
        source_message_id: message.id,
        queued_count: String(dispatchResult.queuedTaskIds.length),
        warning_count: String(warnings.length),
      },
    });
  }
  for (const warning of warnings) {
    state.ledger.unshift({
      title: "Agent output mention warning",
      note: warning,
      code: "agent_output_mentions.warning",
      data: {
        channel_name: channel.name,
        source_message_id: message.id,
      },
    });
  }

  const nextState = writeWorkspaceStateSync(state, effectiveWorkspaceId);
  publishChannelThreadChangedEvent({
    workspaceId: effectiveWorkspaceId,
    channelName: channel.name,
    changedAt: message.time,
  });

  return {
    state: nextState,
    message,
    created: true,
    warnings,
    queuedTaskIds: dispatchResult.queuedTaskIds,
    dispatchedAgentIds: dispatchResult.dispatchedAgentIds,
  };
}

/**
 * Replaces the visible contents of a task-bound pending reply without finalizing it.
 * The task ID prevents concurrent requests to the same employee from sharing a bubble.
 */
export function updatePendingAgentChannelReplySync(input: {
  channel: string;
  sourceTaskQueueId: string;
  delta: string;
  pendingSpeaker?: string;
}, workspaceId?: string): WorkspaceMessage | null {
  const sourceTaskQueueId = input.sourceTaskQueueId.trim();
  if (!sourceTaskQueueId || !input.delta.trim()) {
    return null;
  }

  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const pendingMessages = state.messages.filter((message) =>
    sameValue(message.channel ?? "", input.channel) &&
    message.role === "agent" &&
    message.status === "pending" &&
    message.kind !== "process",
  );
  const taskBoundMessage = pendingMessages.find((message) => message.data?.source_task_queue_id === sourceTaskQueueId);
  const legacyMatches = input.pendingSpeaker?.trim()
    ? pendingMessages.filter((message) => sameValue(message.speaker, input.pendingSpeaker ?? ""))
    : [];
  const pendingMessage = taskBoundMessage ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined);
  if (!pendingMessage) {
    return null;
  }
  const summary = pendingMessage.summary === "Thinking"
    ? input.delta
    : `${pendingMessage.summary}${input.delta}`;
  if (pendingMessage.summary === summary) {
    return pendingMessage;
  }

  const message: WorkspaceMessage = {
    ...pendingMessage,
    data: {
      ...pendingMessage.data,
      source_task_queue_id: sourceTaskQueueId,
    },
    summary,
  };
  state.messages = state.messages.map((candidate) => candidate.id === message.id ? message : candidate);
  writeWorkspaceStateSync(state, effectiveWorkspaceId);
  publishChannelThreadChangedEvent({
    workspaceId: effectiveWorkspaceId,
    channelName: input.channel,
    changedAt: new Date().toISOString(),
  });
  return message;
}

/**
 * Persists a concise execution milestone next to a pending agent reply while
 * retaining the runtime detail in message data for an explicit user expansion.
 */
export function recordAgentChannelProgressSync(input: {
  channel: string;
  sourceTaskQueueId: string;
  speaker: string;
  type: "thinking" | "tool_use" | "tool_result" | "status";
  tool?: string;
  refId?: string;
  content?: string;
  detail?: string;
  conversationId?: string;
}, workspaceId?: string): WorkspaceMessage | null {
  const sourceTaskQueueId = input.sourceTaskQueueId.trim();
  if (!sourceTaskQueueId) {
    return null;
  }

  const state = ensureWorkspaceStateSync(workspaceId);
  const effectiveWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const hasPendingReply = state.messages.some((message) =>
    sameValue(message.channel ?? "", input.channel) &&
    message.role === "agent" &&
    message.status === "pending" &&
    message.data?.source_task_queue_id === sourceTaskQueueId,
  );
  if (!hasPendingReply) {
    return null;
  }

  const progressMessages = state.messages.filter((message) =>
    sameValue(message.channel ?? "", input.channel) &&
    message.kind === "process" &&
    message.data?.source_task_queue_id === sourceTaskQueueId,
  );
  if (input.type === "thinking" && progressMessages.some((message) =>
    message.processType === "thinking" && message.status === "pending",
  )) {
    const runningThinking = progressMessages.find((message) =>
      message.processType === "thinking" && message.status === "pending",
    );
    if (!runningThinking) {
      return null;
    }
    if (runningThinking && input.detail?.trim()) {
      const previousDetail = runningThinking.data?.execution_detail;
      const nextDetail = previousDetail ? `${previousDetail}\n\n${input.detail.trim()}` : input.detail.trim();
      const message: WorkspaceMessage = {
        ...runningThinking,
        data: { ...(runningThinking.data ?? {}), execution_detail: nextDetail },
      };
      state.messages = state.messages.map((candidate) => candidate.id === message.id ? message : candidate);
      writeWorkspaceStateSync(state, effectiveWorkspaceId);
      publishChannelThreadChangedEvent({
        workspaceId: effectiveWorkspaceId,
        channelName: input.channel,
        changedAt: new Date().toISOString(),
      });
    }
    return runningThinking;
  }

  const tool = input.tool?.trim();
  if (input.type === "tool_result") {
    const runningTool = progressMessages.find((message) =>
      message.processType === "tool_use" &&
      message.status === "pending" &&
      (input.refId
        ? message.data?.execution_ref_id === input.refId
        : sameValue(message.tool ?? "", tool ?? "")),
    );
    if (runningTool) {
      const message: WorkspaceMessage = {
        ...runningTool,
        processType: "tool_result",
        status: "completed",
        summary: tool ? `已完成 ${tool}` : "工具执行完成",
        data: {
          ...(runningTool.data ?? {}),
          ...(input.detail?.trim()
            ? {
                execution_detail: `${runningTool.data?.execution_detail ?? ""}${runningTool.data?.execution_detail ? "\n\n" : ""}${input.detail.trim()}`,
              }
            : {}),
        },
      };
      state.messages = state.messages.map((candidate) => candidate.id === message.id ? message : candidate);
      writeWorkspaceStateSync(state, effectiveWorkspaceId);
      publishChannelThreadChangedEvent({
        workspaceId: effectiveWorkspaceId,
        channelName: input.channel,
        changedAt: new Date().toISOString(),
      });
      return message;
    }
  }

  const summary = formatAgentProgressSummary(input.type, tool, input.content);
  const message = pushWorkspaceMessageToChannel(state, input.channel, {
    speaker: input.speaker,
    role: "agent",
    summary,
    code: "agent.progress",
    conversationId: input.conversationId,
    data: {
      source_task_queue_id: sourceTaskQueueId,
      ...(input.refId ? { execution_ref_id: input.refId } : {}),
      ...(input.detail?.trim() ? { execution_detail: input.detail.trim() } : {}),
    },
    status: input.type === "tool_use" || input.type === "thinking" ? "pending" : "completed",
    kind: "process",
    processType: input.type,
    tool,
    recordInChannelHistory: false,
  }, effectiveWorkspaceId);
  writeWorkspaceStateSync(state, effectiveWorkspaceId);
  publishChannelThreadChangedEvent({
    workspaceId: effectiveWorkspaceId,
    channelName: input.channel,
    changedAt: message.time,
  });
  return message;
}

function formatAgentProgressSummary(
  type: "thinking" | "tool_use" | "tool_result" | "status",
  tool: string | undefined,
  content: string | undefined,
): string {
  if (type === "thinking") {
    return "正在分析任务";
  }
  if (type === "tool_use") {
    return tool ? `正在调用 ${tool}` : "正在调用工具";
  }
  if (type === "tool_result") {
    return tool ? `已完成 ${tool}` : "工具执行完成";
  }
  const compact = content?.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : "状态已更新";
}

export function replacePendingChannelMessageSync(input: {
  channel: string;
  pendingSpeaker: string;
  pendingTaskId?: string;
  speaker: string;
  role: "human" | "agent";
  summary: string;
  status?: "pending" | "completed" | "error";
  attachments?: MessageAttachment[];
  conversationId?: string;
}, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const speakerPendingReplies = state.messages.filter((message) =>
    sameValue(message.channel ?? "", input.channel) &&
    message.role === "agent" &&
    message.status === "pending" &&
    message.kind !== "process" &&
    sameValue(message.speaker, input.pendingSpeaker),
  );
  const taskBoundMessages = input.pendingTaskId
    ? speakerPendingReplies.filter((message) => message.data?.source_task_queue_id === input.pendingTaskId)
    : [];
  const legacyMessages = speakerPendingReplies.filter((message) => !message.data?.source_task_queue_id);
  const messagesToReplace = taskBoundMessages.length > 0
    ? taskBoundMessages
    : input.pendingTaskId && legacyMessages.length === 1
      ? legacyMessages
      : input.pendingTaskId
        ? []
        : speakerPendingReplies;
  const messageIdsToReplace = new Set(messagesToReplace.map((message) => message.id));
  state.messages = state.messages.filter((message) => !messageIdsToReplace.has(message.id));
  if (input.pendingTaskId) {
    state.messages = state.messages.map((message) =>
      sameValue(message.channel ?? "", input.channel) &&
      message.kind === "process" &&
      message.status === "pending" &&
      message.data?.source_task_queue_id === input.pendingTaskId
        ? { ...message, status: "completed" }
        : message,
    );
  }

  const message = pushWorkspaceMessageToChannel(state, input.channel, {
    speaker: input.speaker,
    role: input.role,
    summary: input.summary,
    status: input.status ?? "completed",
    attachments: input.attachments,
    conversationId: input.conversationId,
    ...(input.pendingTaskId ? { data: { source_task_queue_id: input.pendingTaskId } } : {}),
  }, workspaceId);

  const nextState = writeWorkspaceStateSync(state, workspaceId);
  publishChannelThreadChangedEvent({
    workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
    channelName: input.channel,
    changedAt: message.time,
  });
  return nextState;
}

function buildAgentOutputMentionParseWarnings(parse: ChannelMentionParseResult): string[] {
  const warnings: string[] = [];
  for (const token of parse.unknownMentions) {
    warnings.push(`Agent output mentioned @${token}, but no channel member or Agent matches that name.`);
  }
  for (const mention of parse.outOfChannelAgentMentions) {
    warnings.push(`Agent output mentioned @${mention.token}, but Agent "${mention.label}" is not in this channel.`);
  }
  for (const mention of parse.outOfChannelHumanMentions) {
    warnings.push(`Agent output mentioned @${mention.token}, but member "${mention.label}" is not in this channel.`);
  }
  return warnings;
}

function emptyChannelMentionParseResult(): ChannelMentionParseResult {
  return {
    agentMentions: [],
    humanMentions: [],
    unknownMentions: [],
    outOfChannelAgentMentions: [],
    outOfChannelHumanMentions: [],
    allMentions: [],
  };
}

function dispatchAgentOutputMentionsSync(
  state: DofeAgentState,
  input: {
    channelName: string;
    sourceMessage: WorkspaceMessage;
    sourceTaskQueueId?: string;
    initiatorAgentId: string;
    agentMentions: AgentMessageMention[];
    workspaceId: string;
    requestedByUserId?: string;
    requestedByDisplayName?: string;
    mentionCascadeDepth?: number;
    mentionRootMessageId?: string;
    sessionId?: string;
    workDir?: string;
  },
): { queuedTaskIds: string[]; dispatchedAgentIds: string[]; warnings: string[] } {
  const queuedTaskIds: string[] = [];
  const dispatchedAgentIds: string[] = [];
  const warnings: string[] = [];
  if (input.agentMentions.length === 0) {
    return { queuedTaskIds, dispatchedAgentIds, warnings };
  }

  const currentDepth = normalizeMentionCascadeDepth(input.mentionCascadeDepth);
  const mentionRootMessageId = input.mentionRootMessageId?.trim() || input.sourceMessage.id;
  if (currentDepth >= AGENT_OUTPUT_MENTION_MAX_CASCADE_DEPTH) {
    warnings.push(
      `Agent output mention cascade depth ${currentDepth} reached the limit ${AGENT_OUTPUT_MENTION_MAX_CASCADE_DEPTH}; no follow-up agent task was created.`,
    );
    return { queuedTaskIds, dispatchedAgentIds, warnings };
  }

  let rootTaskCount = countAgentOutputMentionTasksForRoot(input.workspaceId, mentionRootMessageId);
  const nextDepth = currentDepth + 1;
  const mentionedAgentIds = input.agentMentions.map((mention) => mention.agentId);
  const mentionedAgentLabels = input.agentMentions.map((mention) => mention.label);
  // 会话拆分：AI 回复里的二次 @员工 继承原任务的 Conversation/Lane。
  const sourceTask = input.sourceTaskQueueId ? readQueuedTaskSync(input.sourceTaskQueueId) : null;
  const sourceConversationId = sourceTask?.conversationId;

  for (const mention of input.agentMentions) {
    if (queuedTaskIds.length >= AGENT_OUTPUT_MENTION_MAX_DISPATCHES) {
      warnings.push(
        `Agent output mentioned @${mention.token}, but each reply can dispatch at most ${AGENT_OUTPUT_MENTION_MAX_DISPATCHES} agent task(s).`,
      );
      continue;
    }
    if (rootTaskCount >= AGENT_OUTPUT_MENTION_MAX_ROOT_TASKS) {
      warnings.push(
        `Agent output mentioned @${mention.token}, but mention root ${mentionRootMessageId} already reached the ${AGENT_OUTPUT_MENTION_MAX_ROOT_TASKS} task limit.`,
      );
      continue;
    }
    if (sameValue(input.initiatorAgentId, mention.agentId)) {
      warnings.push(`Agent output mentioned itself as @${mention.token}; self-mentions do not create follow-up tasks.`);
      continue;
    }
    if (hasQueuedAgentOutputMentionForSource(
      input.workspaceId,
      input.sourceMessage.id,
      input.sourceTaskQueueId,
      mention.agentId,
    )) {
      warnings.push(`Agent output already dispatched @${mention.token} for this task result.`);
      continue;
    }

    const agent = state.activeEmployees.find((employee) => sameValue(employee.name, mention.agentId));
    if (!agent || !agent.channels.some((channelName) => sameValue(channelName, input.channelName))) {
      warnings.push(`Agent output mentioned @${mention.token}, but the target Agent is not available in channel ${input.channelName}.`);
      continue;
    }
    if (!input.requestedByUserId && agent.ownerUserId) {
      warnings.push(`Agent output mentioned @${mention.token}, but personal Agent "${agent.name}" requires a human requester context.`);
      continue;
    }
    if (input.requestedByUserId) {
      try {
        assertCanUseEmployeeInChannelForActorSync({
          workspaceId: input.workspaceId,
          employeeName: agent.name,
          channelName: input.channelName,
          actorUserId: input.requestedByUserId,
          actorDisplayName: input.requestedByDisplayName,
        });
        assertCanUseBoundEmployeeRuntimeInChannelForActorSync({
          workspaceId: input.workspaceId,
          employeeName: agent.name,
          channelName: input.channelName,
          actorUserId: input.requestedByUserId,
          actorDisplayName: input.requestedByDisplayName,
        });
      } catch (error) {
        warnings.push(
          `Agent output mentioned @${mention.token}, but the inherited requester cannot dispatch that Agent: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    const existingExecutionWorkspace = readConversationExecutionWorkspaceState(state, {
      channelName: input.channelName,
      agentId: agent.name,
      conversationId: sourceConversationId,
    });
    const lastExecution = readLatestChannelExecutionSync(agent.name, input.channelName, input.workspaceId);
    const resumedSessionId = existingExecutionWorkspace?.sessionId ?? lastExecution?.sessionId;
    const resumedWorkDir = existingExecutionWorkspace?.workDir ?? lastExecution?.workDir;
    // 会话作用域：按被提及员工解析 Lane，Session 交由 Router Session 解析。
    let mentionConversationId = sourceConversationId;
    let mentionLaneId: string | undefined;
    if (sourceConversationId) {
      const employeeId = resolveStoredEmployeeIdSync(agent.name, input.workspaceId);
      if (employeeId) {
        const mentionLane = ensureExecutionLaneForConversationSync({
          workspaceId: input.workspaceId,
          conversationId: sourceConversationId,
          employeeId,
          employeeName: agent.name,
          kind: "group",
          channelId: input.channelName,
        });
        mentionLaneId = mentionLane.id;
      } else {
        mentionConversationId = undefined;
      }
    }
    const queued = enqueueNativeTaskSync({
      workspaceId: input.workspaceId,
      ...(input.sourceTaskQueueId ? {
        idempotencyKey: `agent-output-mention:${input.sourceTaskQueueId}:${agent.name.toLocaleLowerCase()}`,
      } : {}),
      assignee: agent.name,
      title: `Agent @提及 · ${input.channelName} · ${mention.label}`,
      channel: input.channelName,
      priority: "medium",
      triggerType: "mention_chat",
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
      conversationId: mentionConversationId,
      executionLaneId: mentionLaneId,
      metadata: {
        mentionSource: "agent_output",
        initiatorAgentId: input.initiatorAgentId,
        sourceChannel: input.channelName,
        sourceMessageId: input.sourceMessage.id,
        sourceTaskQueueId: input.sourceTaskQueueId,
        mentionType: "agent",
        mentionedAgentIds,
        mentionedAgentLabels,
        assigneeMentionToken: mention.token,
        channelName: input.channelName,
        channelMessage: input.sourceMessage.summary,
        channelHistory: sourceConversationId
          ? buildConversationHistorySnapshot(state, input.channelName, sourceConversationId)
          : buildChannelHistorySnapshot(state, input.channelName),
        channelHistoryPath: sourceConversationId ? undefined : getChannelHistoryFilePath(input.channelName, input.workspaceId),
        channelSessionId: sourceConversationId ? undefined : resumedSessionId,
        mentionCascadeDepth: nextDepth,
        mentionRootMessageId,
      },
    });
    if (!queued) {
      warnings.push(`Agent output mentioned @${mention.token}, but the target Agent does not have an executable runtime bound.`);
      continue;
    }

    queuedTaskIds.push(queued.id);
    dispatchedAgentIds.push(agent.name);
    rootTaskCount += 1;
    upsertConversationExecutionWorkspaceState(state, {
      channelName: input.channelName,
      agentId: agent.name,
      conversationId: mentionConversationId,
      sessionId: mentionConversationId ? null : (resumedSessionId ?? input.sessionId),
      workDir: mentionConversationId
        ? null
        : (resumedWorkDir ?? input.workDir ?? resolveConversationExecutionWorkspacePath({
            workspaceId: input.workspaceId,
            channelName: input.channelName,
            agentId: agent.name,
          })),
      lastTaskQueueId: queued.id,
      lastError: null,
    });
    pushWorkspaceMessageToChannel(state, input.channelName, {
      speaker: agent.name,
      role: "agent",
      summary: "Thinking",
      code: "agent.pending",
      conversationId: sourceConversationId,
      data: {
        agent_name: agent.name,
        source_message_id: input.sourceMessage.id,
        mention_source: "agent_output",
        source_task_queue_id: queued.id,
      },
      status: "pending",
    }, input.workspaceId);
  }

  return { queuedTaskIds, dispatchedAgentIds, warnings };
}

function normalizeMentionCascadeDepth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function countAgentOutputMentionTasksForRoot(workspaceId: string, mentionRootMessageId: string): number {
  return listQueuedTasksSync({ workspaceId }).filter((task) => {
    const payload = safeParseQueuePayload(task.inputJson);
    return payload?.mentionSource === "agent_output" && payload.mentionRootMessageId === mentionRootMessageId;
  }).length;
}

function hasQueuedAgentOutputMentionForSource(
  workspaceId: string,
  sourceMessageId: string,
  sourceTaskQueueId: string | undefined,
  targetAgentId: string,
): boolean {
  return listQueuedTasksSync({ workspaceId }).some((task) => {
    const payload = safeParseQueuePayload(task.inputJson);
    return (
      task.agentId === targetAgentId &&
      payload?.mentionSource === "agent_output" &&
      (sourceTaskQueueId
        ? payload.sourceTaskQueueId === sourceTaskQueueId
        : payload.sourceMessageId === sourceMessageId)
    );
  });
}

function safeParseQueuePayload(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatUserFacingTaskFailure(errorText: string): string {
  const trimmed = errorText.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "运行时返回了空错误。";
  }
  if (
    /No such image:\s*dofe\/agent-runtime-[^\s'";]+/i.test(trimmed)
    || /Approved managed runtime image\s+dofe\/agent-runtime-[^\s'";]+\s+is unavailable locally/i.test(trimmed)
  ) {
    return "执行环境尚未就绪，任务未能启动。请联系管理员完成 Runtime 镜像安装后重试。";
  }
  if (/--dangerously-skip-permissions cannot be used with root\/sudo privileges/i.test(trimmed)) {
    return "运行时权限模式与 root/sudo 环境不兼容，任务未能启动。";
  }
  if (/This command requires approval/i.test(trimmed)) {
    return "运行时需要命令审批，但当前会话无法交互审批。";
  }
  if (/provider\.model_unavailable|令牌状态不可用|upstream provider authentication failed|provider authentication failed/i.test(trimmed)) {
    return "当前模型线路的供应商凭证不可用，请切换模型重试；若多个模型都失败，请联系管理员更新供应商凭证。";
  }
  if (/unexpected argument ['"]--sandbox['"]|exec resume[\s\S]*--sandbox/i.test(trimmed)) {
    return "绑定执行引擎上的 Codex CLI 不支持当前会话续接参数；已阻止跨引擎改派，请更新执行引擎后重试。";
  }
  if (/stream disconnected[\s\S]*(response\.completed|turn\.failed)|response\.completed[\s\S]*not received|turn\.failed/i.test(trimmed)) {
    return "模型的流式响应在完成前中断，自动重试后仍未完成。请检查模型连接或切换模型后重试。";
  }
  if (/model metadata[\s\S]*not found|model metadata[\s\S]*fallback metadata/i.test(trimmed)) {
    return "所选模型的执行配置不完整，无法稳定建立流式连接。请切换到已验证的模型后重试。";
  }
  if (/runtime approval timed out|审批等待超时/i.test(trimmed)) {
    return "等待你的工具审批已超时，任务已停止。请重新发送任务，并在出现审批卡片后处理。";
  }
  if (/(?:\bHTTP\s*)?500\s+Internal Server Error|\bInternal Server Error\b/i.test(trimmed)) {
    return "上游模型服务暂时不可用，任务未完成。请稍后重试或切换模型；完整错误已保留在执行记录中。";
  }
  const diagnosticStart = trimmed.search(
    /\s*(?:\((?:code|exitCode|timedOut|events|resultEvent|textEvent|toolEvent|parseErrors|nonJsonLines|stdoutTail|stderrTail|sessionId)=|provider diagnostic:)/i,
  );
  const withoutDiagnosticBlock = diagnosticStart >= 0 ? trimmed.slice(0, diagnosticStart).trim() : trimmed;
  const compact = withoutDiagnosticBlock || trimmed;
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function writeChannelMessageStateAndPublish(
  state: DofeAgentState,
  workspaceId: string,
  channelName: string,
  messageId: string,
  createdAt: string,
): DofeAgentState {
  const nextState = writeWorkspaceStateSync(state, workspaceId);
  publishChannelMessageCreatedEvent({
    workspaceId,
    channelName,
    messageId,
    createdAt,
  });
  return nextState;
}
