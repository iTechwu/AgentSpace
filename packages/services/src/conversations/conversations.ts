// 多会话拆分服务层（docs/0820/session-split）。
// 在 DB 领域访问层之上叠加授权与业务规则：创建、列表、读取、归档、摘要和发送前的 Lane 解析。

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
