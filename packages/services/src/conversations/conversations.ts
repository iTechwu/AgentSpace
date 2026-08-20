// 多会话拆分服务层（docs/0820/session-split）。
// 在 DB 领域访问层之上叠加授权与业务规则：创建、列表、读取、归档、摘要、legacy 回填和发送前的 Lane 解析。

import { createHash } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  archiveConversationSync,
  createConversationSync,
  ensureExecutionLaneForConversationSync,
  listConversationParticipantsSync,
  listConversationsForChannelSync,
  listConversationsForEmployeeSync,
  readConversationSync,
  readExecutionLaneForConversationEmployeeSync,
  readStoredChannelSync,
  readStoredEmployeeByIdSync,
  resolveStoredEmployeeIdSync,
  writeConversationMessageSync,
  unarchiveConversationSync,
  updateConversationSync,
  type ConversationExecutionLaneRecord,
  type ConversationKind,
  type ConversationRecord,
  type ConversationStatus,
  type ConversationSummarySource,
} from "@dofe-agent/db";
import {
  assertCanUseEmployeeForActorSync,
  isWorkspaceAdminOrOwnerSync,
} from "../runtime-access/runtime-access.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";

export interface CreateConversationForUserInput {
  workspaceId?: string;
  /** 直接会话：目标员工 ID。 */
  employeeId?: string;
  channelId?: string;
  /** 群聊会话：目标频道名（kind=group）。 */
  channelName?: string;
  createdByUserId?: string;
  kind?: ConversationKind;
  idempotencyKey?: string;
}

export interface CreateConversationForUserResult {
  conversation: ConversationRecord;
  /** 直接会话创建即建立 Lane；群聊 Lane 按 employee 惰性建立。 */
  lane?: ConversationExecutionLaneRecord;
  employeeName?: string;
}

/** /new：创建服务端 Conversation（docs §5.1）。直接会话同步建立 Lane；群聊只建会话与参与者。 */
export function createConversationForUserSync(input: CreateConversationForUserInput): CreateConversationForUserResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const kind: ConversationKind = input.kind ?? "direct";

  if (kind === "group") {
    if (!input.channelName) {
      throw new Error("channelName is required for a group conversation.");
    }
    const channel = readStoredChannelSync(input.channelName, workspaceId);
    if (!channel) {
      throw new Error(`Channel "${input.channelName}" does not exist in this workspace.`);
    }
    const employeeParticipants: Array<{ employeeId: string; employeeName?: string }> = [];
    for (const employeeName of channel.employeeNames) {
      const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
      if (employeeId) {
        assertCanUseEmployeeForActorSync({ workspaceId, employeeName, actorUserId: input.createdByUserId });
        employeeParticipants.push({ employeeId, employeeName });
      }
    }
    const result = createConversationSync({
      workspaceId,
      kind: "group",
      channelId: input.channelName,
      createdByUserId: input.createdByUserId,
      employeeParticipants,
      idempotencyKey: input.idempotencyKey,
    });
    return { conversation: result.conversation };
  }

  if (!input.employeeId) {
    throw new Error("employeeId is required for a direct conversation.");
  }
  const employee = readStoredEmployeeByIdSync(input.employeeId, workspaceId);
  if (!employee) {
    throw new Error(`Employee "${input.employeeId}" does not exist in this workspace.`);
  }
  assertCanUseEmployeeForActorSync({
    workspaceId,
    employeeName: employee.name,
    actorUserId: input.createdByUserId,
  });
  const result = createConversationSync({
    workspaceId,
    employeeId: input.employeeId,
    employeeName: employee.name,
    kind: "direct",
    channelId: input.channelId,
    createdByUserId: input.createdByUserId,
    idempotencyKey: input.idempotencyKey,
  });
  return { conversation: result.conversation, lane: result.lane, employeeName: employee.name };
}

export interface ListConversationsForUserInput {
  workspaceId?: string;
  employeeId: string;
  actorUserId?: string;
  statuses?: ConversationStatus[];
  cursor?: string;
  limit?: number;
}

/** 历史会话列表按 employee 范围 + 授权过滤（docs §5.2）。 */
export function listConversationsForEmployeeForUserSync(input: ListConversationsForUserInput): ConversationRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  // legacy 回填生产入口：打开历史时惰性回填既有消息（幂等，docs Phase 5.1）。
  try {
    backfillLegacyConversationsSync(workspaceId);
  } catch {
    // 回填失败不阻塞历史读取。
  }
  const employee = readStoredEmployeeByIdSync(input.employeeId, workspaceId);
  if (!employee) {
    throw new Error(`Employee "${input.employeeId}" does not exist in this workspace.`);
  }
  assertCanUseEmployeeForActorSync({
    workspaceId,
    employeeName: employee.name,
    actorUserId: input.actorUserId,
  });
  // 跨用户信息隔离：普通用户只看自己创建/参与的会话；管理员/所有者可看全部（docs §9）。
  const isPrivileged = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId });
  return listConversationsForEmployeeSync({
    workspaceId,
    employeeId: input.employeeId,
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
    humanUserId: isPrivileged ? undefined : input.actorUserId,
  });
}

export interface ListConversationsForChannelForUserInput {
  workspaceId?: string;
  channelName: string;
  actorUserId?: string;
  statuses?: ConversationStatus[];
  cursor?: string;
  limit?: number;
}

/** 群聊历史会话列表按 channel 范围 + 授权过滤（docs §5.2 group 场景）。 */
export function listConversationsForChannelForUserSync(input: ListConversationsForChannelForUserInput): ConversationRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  // legacy 回填生产入口（幂等）。
  try {
    backfillLegacyConversationsSync(workspaceId);
  } catch {
    // 回填失败不阻塞历史读取。
  }
  const channel = readStoredChannelSync(input.channelName, workspaceId);
  if (!channel) {
    throw new Error(`Channel "${input.channelName}" does not exist in this workspace.`);
  }
  const isPrivileged = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId });
  return listConversationsForChannelSync({
    workspaceId,
    channelId: input.channelName,
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
    humanUserId: isPrivileged ? undefined : input.actorUserId,
  });
}

export interface ReadConversationForUserInput {
  workspaceId?: string;
  conversationId: string;
  actorUserId?: string;
}

/** 读取单个 Conversation 并校验工作区归属与参与者权限（docs §9）。 */
export function readConversationForUserSync(input: ReadConversationForUserInput): ConversationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conversation = readConversationSync(input.conversationId);
  if (!conversation || conversation.workspaceId !== workspaceId) {
    throw new Error("Conversation not found in this workspace.");
  }
  assertCanReadConversationSync(workspaceId, conversation, input.actorUserId);
  return conversation;
}

export function archiveConversationForUserSync(input: ReadConversationForUserInput): ConversationRecord {
  const conversation = readConversationForUserSync(input);
  // 归档不取消运行中的 task（docs §5.6）；运行结果仍可写入历史与通知。
  return archiveConversationSync(conversation.id);
}

export function unarchiveConversationForUserSync(input: ReadConversationForUserInput): ConversationRecord {
  const conversation = readConversationForUserSync(input);
  return unarchiveConversationSync(conversation.id);
}

export interface UpdateConversationSummaryForUserInput {
  workspaceId?: string;
  conversationId: string;
  actorUserId?: string;
  title?: string;
  summary?: string;
  summarySource?: ConversationSummarySource;
}

/** 用户手动重命名 / 摘要覆盖，summary_source=user 时后台摘要不得覆盖（docs §5.5、§8）。 */
export function updateConversationSummaryForUserSync(input: UpdateConversationSummaryForUserInput): ConversationRecord {
  const conversation = readConversationForUserSync({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
  });
  return updateConversationSync({
    conversationId: conversation.id,
    title: input.title ?? null,
    summary: input.summary ?? null,
    summarySource: input.summarySource,
  });
}

/** 生成一句话摘要：去 Markdown 标题/列表符号/换行，中文限 60 字（docs §4.2、§8）。 */
export function buildConversationSummary(text: string): string {
  const lines = text.split(/\r?\n/);
  const cleaned = lines
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").trim())
    .filter(Boolean);
  const first = cleaned[0] ?? "";
  const compact = first.replace(/\s+/g, " ").trim();
  const value = compact || "新会话";
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

export interface RecordConversationMessageActivityInput {
  workspaceId?: string;
  conversationId: string;
  actorUserId?: string;
  firstMessageText?: string;
  now?: string;
}

/** 消息发送后刷新会话活动时间；首条消息同时 draft→active 并写 fallback 摘要（docs §2.1、§5.4）。 */
export function recordConversationMessageActivitySync(input: RecordConversationMessageActivityInput): ConversationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conversation = readConversationForUserSync({
    workspaceId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
  });
  const now = input.now ?? new Date().toISOString();
  const isFirst = conversation.status === "draft";
  return updateConversationSync({
    conversationId: conversation.id,
    status: isFirst ? "active" : conversation.status,
    summary: isFirst && input.firstMessageText ? buildConversationSummary(input.firstMessageText) : null,
    summarySource: isFirst && input.firstMessageText ? "fallback" : undefined,
    lastMessageAt: now,
    lastActivityAt: now,
    now,
  });
}

export interface RefreshConversationSummaryAfterReplyInput {
  workspaceId?: string;
  conversationId: string;
  replyText: string;
}

/** 首个 AI 最终回复后生成正式摘要（docs §8）；summary_source=user 不覆盖。 */
export function refreshConversationSummaryAfterReplySync(input: RefreshConversationSummaryAfterReplyInput): ConversationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conversation = readConversationSync(input.conversationId);
  if (!conversation || conversation.workspaceId !== workspaceId) {
    return null;
  }
  if (conversation.summarySource === "user") {
    return conversation;
  }
  const summary = buildConversationSummary(input.replyText);
  if (!summary || summary === "新会话") {
    return conversation;
  }
  return updateConversationSync({
    conversationId: conversation.id,
    summary,
    summarySource: "generated",
  });
}

export interface ResolveConversationLaneForSendInput {
  workspaceId?: string;
  conversationId: string;
  employeeId: string;
  actorUserId?: string;
}

/** 发送前：校验会话权限并 find-or-create 该 Conversation 的 Execution Lane（docs §5.4 步骤 3）。 */
export function resolveConversationLaneForSendSync(input: ResolveConversationLaneForSendInput): {
  conversation: ConversationRecord;
  lane: ConversationExecutionLaneRecord;
  employeeName: string;
} {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conversation = readConversationForUserSync({
    workspaceId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
  });
  const employee = readStoredEmployeeByIdSync(input.employeeId, workspaceId);
  if (!employee) {
    throw new Error(`Employee "${input.employeeId}" does not exist in this workspace.`);
  }
  assertCanUseEmployeeForActorSync({
    workspaceId,
    employeeName: employee.name,
    actorUserId: input.actorUserId,
  });
  // 目标 employee 必须是该 Conversation 的 participant（docs §3 授权边界）：
  // 否则会为同一 Conversation 建立第二个 employee Lane，破坏「一会话一泳道」。
  const isEmployeeParticipant = listConversationParticipantsSync(conversation.id)
    .some((participant) => participant.participantType === "employee" && participant.employeeId === input.employeeId);
  if (!isEmployeeParticipant) {
    throw new Error("This employee is not a participant of the conversation.");
  }
  const lane = ensureExecutionLaneForConversationSync({
    workspaceId,
    conversationId: conversation.id,
    employeeId: input.employeeId,
    employeeName: employee.name,
    kind: conversation.kind,
    channelId: conversation.channelId,
  });
  return { conversation, lane, employeeName: employee.name };
}

function assertCanReadConversationSync(
  workspaceId: string,
  conversation: ConversationRecord,
  actorUserId?: string,
): void {
  if (isWorkspaceAdminOrOwnerSync({ workspaceId, userId: actorUserId })) {
    return;
  }
  if (actorUserId) {
    const isHumanParticipant = listConversationParticipantsSync(conversation.id)
      .some((participant) => participant.participantType === "human" && participant.userId === actorUserId);
    if (isHumanParticipant) {
      return;
    }
  }
  throw new Error("You do not have access to this conversation.");
}

export interface BackfillLegacyConversationsResult {
  conversationsCreated: number;
  messagesTagged: number;
}

/**
 * Legacy 回填（docs/0820/session-split Phase 5.1）：为每个 channel 的既有消息创建一个确定性
 * legacy Conversation，并把无 conversationId 的消息打标到该会话，避免根据内容猜测历史边界。
 * 幂等：同一 channel 的重复运行复用同一 legacy Conversation。
 */
export function backfillLegacyConversationsSync(workspaceId = DEFAULT_WORKSPACE_ID): BackfillLegacyConversationsResult {
  const state = ensureWorkspaceStateSync(workspaceId);
  let conversationsCreated = 0;
  let messagesTagged = 0;

  for (const channel of state.channels) {
    const channelName = channel.name;
    const kind: ConversationKind = channel.kind === "direct" ? "direct" : "group";
    const employeeParticipants: Array<{ employeeId: string; employeeName?: string }> = [];
    for (const employeeName of channel.employeeNames ?? []) {
      const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
      if (employeeId) {
        employeeParticipants.push({ employeeId, employeeName });
      }
    }

    const legacyMessages = state.messages.filter(
      (message) => sameValue(message.channel ?? "", channelName) && !message.conversationId,
    );
    if (legacyMessages.length === 0) {
      continue;
    }

    const legacyId = `conversation-legacy-${createHash("sha256").update(`${workspaceId}\0${channelName}`).digest("hex").slice(0, 32)}`;
    // 从既有 human 消息抽取 userId，作为 human participant 归属，避免普通成员看不到回填会话（docs §9）。
    const legacyUserId = legacyMessages.find((message) => message.role === "human" && message.speakerUserId)?.speakerUserId;
    if (!readConversationSync(legacyId)) {
      createConversationSync({
        workspaceId,
        id: legacyId,
        kind,
        channelId: channelName,
        createdByUserId: legacyUserId,
        employeeId: kind === "direct" ? employeeParticipants[0]?.employeeId : undefined,
        employeeName: kind === "direct" ? employeeParticipants[0]?.employeeName : undefined,
        employeeParticipants: kind === "group" ? employeeParticipants : undefined,
      });
      conversationsCreated += 1;
    }

    state.messages = state.messages.map((message) =>
      (sameValue(message.channel ?? "", channelName) && !message.conversationId)
        ? { ...message, conversationId: legacyId }
        : message,
    );
    messagesTagged += legacyMessages.length;
    // 镜像到 conversation_message 表（docs §2.5）。
    for (const message of legacyMessages) {
      writeConversationMessageSync({
        id: message.id,
        workspaceId,
        conversationId: legacyId,
        channel: message.channel,
        speaker: message.speaker,
        speakerUserId: message.speakerUserId,
        role: message.role,
        summary: message.summary,
        status: message.status ?? "completed",
        kind: message.kind,
        processType: message.processType,
        tool: message.tool,
        code: message.code,
        data: message.data,
        time: message.time,
      });
    }
    const firstMessage = legacyMessages[0];
    updateConversationSync({
      conversationId: legacyId,
      status: "active",
      summary: firstMessage?.summary ? buildConversationSummary(firstMessage.summary) : null,
      summarySource: firstMessage?.summary ? "generated" : undefined,
      // WorkspaceMessage.time 是展示时间（如 10:00），不能写入 TIMESTAMPTZ；legacy 用回填时刻近似。
      lastMessageAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
  }

  if (messagesTagged > 0) {
    writeWorkspaceStateSync(state, workspaceId);
  }
  return { conversationsCreated, messagesTagged };
}
