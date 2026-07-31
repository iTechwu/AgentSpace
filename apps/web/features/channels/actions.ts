"use server";

import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { resolveWorkspaceAccessForIdentifierSync } from "@/features/auth/server-workspace-resolver";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { getWorkspaceChannelVisibilitySync } from "@/features/auth/workspace-channel-visibility";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import type { ChannelDocumentAccessRole } from "@dofe-agent/domain";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  addChannelEmployeesSync,
  addWorkspaceMemberToChannelForActorSync,
  addChannelDocumentCollaboratorSync,
  assertCanUseEmployeeForActorSync,
  archiveChannelDocumentSync,
  approveChannelAccessRequestForActorSync,
  restoreChannelDocumentSync,
  createChannelParticipantsForMembersSync,
  createChannelDocumentFromAttachmentSync,
  createChannelDocumentSync,
  deleteChannelSync,
  deleteChannelAttachmentSync,
  exportChannelDocumentAsAttachmentSync,
  canReadChannelForActorSync,
  canViewChannelDocumentSync,
  renameChannelSync,
  removeChannelDocumentCollaboratorSync,
  resolveChannelDocumentConflictSync,
  retryChannelDocumentConflictSync,
  rollbackChannelDocumentVersionSync,
  updateChannelDocumentAccessRoleSync,
  acknowledgeMessageSync,
  createChannelSync,
  inviteUserToChannelForActorSync,
  sendContactMessageForHumanWithAttachmentsSync,
  sendChannelHumanMessageSync,
  sendHumanDirectMessageSync,
  pinMessageSync,
  readWorkspaceStateSync,
  rejectChannelAccessRequestForActorSync,
  requestChannelAccessForActorSync,
  revokeChannelInvitationForActorSync,
  sameValue,
  unpinMessageSync,
  updateEmployeeRemarkNameSync,
  upsertChannelDocumentPresenceSync,
  updateChannelDocumentSync,
  reviewApprovalSync,
  listApprovalsSync,
  listEmployeeSkillIdsSync,
  listWorkspaceSkillsSync,
  replacePendingChannelMessageSync,
  FEISHU_PROVIDER_ID,
  readFeishuChatMemberSnapshot,
  readFeishuIntegrationCredentials,
  setSessionModelOverrideForChatCommandSync,
  validateSessionModelOverrideForChatCommandAsync,
  ChatModelOverrideValidationError,
  resolveAgentRuntimeMode,
  resolveChatModelOverrideAsync,
} from "@dofe-agent/services";
import {
  cancelQueuedTaskSync,
  listExternalChannelBindingsSync,
  listExternalIntegrationsSync,
  readQueuedTaskSync,
} from "@dofe-agent/db";
import { persistFormAttachments } from "@/features/chat/attachment-actions";
import { parseModelCommand } from "@/features/chat/model-command";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";
import { getChannelDetailData, type ChannelDetailPageData } from "@/features/dashboard/data";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";

export async function createChannelAction(input: {
  name: string;
  humanMemberIds: string[];
  agentIds: string[];
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const humanMemberIds = dedupeStrings([
    ...input.humanMemberIds,
    workspaceContext.currentUser.displayName,
  ]);
  const channelName = input.name.trim() || `群聊-${Date.now()}`;
  for (const agentId of input.agentIds) {
    assertCanUseEmployeeForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      employeeName: agentId,
      actorUserId: workspaceContext.currentUser.id,
    });
  }

  createChannelSync({
    name: channelName,
    humanMemberNames: humanMemberIds,
    employeeNames: input.agentIds,
  }, workspaceContext.currentWorkspace.id);
  createChannelParticipantsForMembersSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName,
    memberDisplayNames: humanMemberIds,
    addedByUserId: workspaceContext.currentUser.id,
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
}

export async function requestChannelAccessAction(channelName: string, workspaceIdentifier?: string): Promise<void> {
  const workspaceContext = await requireActionWorkspaceContext(workspaceIdentifier);
  assertRequired(channelName, "channel name");

  requestChannelAccessForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName: channelName.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/permissions", "/inbox"]);
}

export async function getChannelDetailDataAction(input: {
  channelName: string;
  workspaceId?: string;
}): Promise<ChannelDetailPageData> {
  const workspaceContext = await requireActionWorkspaceContext(input.workspaceId);
  const channelName = input.channelName.trim();
  assertRequired(channelName, "channel name");
  if (
    !canReadChannelForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName,
      actor: {
        userId: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        role: workspaceContext.currentMembership.role,
      },
    })
  ) {
    throw new Error("Forbidden.");
  }

  return getChannelDetailData({
    channelName,
    currentUserDisplayName: workspaceContext.currentUser.displayName,
    workspaceId: workspaceContext.currentWorkspace.id,
    currentUserId: workspaceContext.currentUser.id,
    currentMembershipRole: workspaceContext.currentMembership.role,
  });
}

export async function getFeishuChannelMemberSnapshotAction(input: {
  channelName: string;
  workspaceId?: string;
}): Promise<Awaited<ReturnType<typeof readFeishuChatMemberSnapshot>> | null> {
  const workspaceContext = await requireActionWorkspaceContext(input.workspaceId);
  const channelName = input.channelName.trim();
  assertRequired(channelName, "channel name");
  if (
    !canReadChannelForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName,
      actor: {
        userId: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        role: workspaceContext.currentMembership.role,
      },
    })
  ) {
    throw new Error("Forbidden.");
  }

  const integrations = listExternalIntegrationsSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    provider: FEISHU_PROVIDER_ID,
  }).filter((integration) => integration.status === "active");
  for (const integration of integrations) {
    const binding = listExternalChannelBindingsSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      integrationId: integration.id,
      status: "active",
    }).find((candidate) => candidate.channelName === channelName);
    if (!binding || !integration.appId) {
      continue;
    }
    try {
      const credentials = readFeishuIntegrationCredentials(integration);
      if (!credentials.appSecret) {
        continue;
      }
      return await readFeishuChatMemberSnapshot({
        appId: integration.appId,
        appSecret: credentials.appSecret,
        chatId: binding.externalChatId,
      });
    } catch {
      // Live membership is optional. Keep the local channel summary on any permission or API failure.
      return null;
    }
  }

  return null;
}

export async function approveChannelAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(requestId, "request id");

  approveChannelAccessRequestForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId: requestId.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/permissions"]);
}

export async function rejectChannelAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(requestId, "request id");

  rejectChannelAccessRequestForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId: requestId.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/permissions"]);
}

export async function reviewInlineApprovalAction(
  approvalId: string,
  decision: "approved" | "rejected",
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(approvalId, "approval id");

  reviewApprovalSync(approvalId.trim(), decision, undefined, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/inbox", "/agents"]);
  return actionToastResult(
    undefined,
    successToast(
      decision === "approved" ? "已批准" : "已驳回",
      decision === "approved" ? "Approved" : "Rejected",
    ),
    buildInlineApprovalInvalidation(workspaceContext.currentWorkspace.id, approvalId.trim()),
  );
}

export async function stopChannelTaskAction(taskId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(taskId, "task id");
  const task = readQueuedTaskSync(taskId.trim());
  if (!task || task.workspaceId !== workspaceContext.currentWorkspace.id) {
    throw new Error("Task does not exist.");
  }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return;
  }

  const payload = parseQueuedTaskPayload(task.inputJson);
  const channelName = readPayloadString(payload, "channelName") ?? readPayloadString(payload, "channel");
  if (!channelName) {
    throw new Error("Task is not attached to a conversation.");
  }
  assertChannelAccess(workspaceContext, channelName);
  const canManageAllTasks = workspaceContext.currentMembership.role === "owner" || workspaceContext.currentMembership.role === "admin";
  if (task.requestedByUserId && task.requestedByUserId !== workspaceContext.currentUser.id && !canManageAllTasks) {
    throw new Error("Only the requester or a workspace administrator can stop this task.");
  }

  for (const approval of listApprovalsSync(task.workspaceId)) {
    if (approval.status === "pending" && approval.sourceId === task.id) {
      reviewApprovalSync(
        approval.id,
        "rejected",
        "Task stopped by the user.",
        task.workspaceId,
      );
    }
  }

  cancelQueuedTaskSync({
    taskId: task.id,
    errorText: `Stopped by ${workspaceContext.currentUser.displayName.trim() || "the user"}.`,
  });
  replacePendingChannelMessageSync({
    channel: channelName,
    pendingSpeaker: task.agentId,
    pendingTaskId: task.id,
    speaker: "系统提示",
    role: "agent",
    summary: `${task.agentId} 的执行已停止。`,
    status: "completed",
  }, task.workspaceId);

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents", "/approvals"]);
}

export async function addWorkspaceMembersToChannelAction(input: {
  channelName: string;
  userIds: string[];
  agentIds?: string[];
  workspaceId?: string;
}): Promise<void> {
  const workspaceContext = await requireActionWorkspaceContext(input.workspaceId);
  assertRequired(input.channelName, "channel name");
  const userIds = dedupeStrings(Array.isArray(input.userIds) ? input.userIds : []);
  const agentIds = dedupeStrings(Array.isArray(input.agentIds) ? input.agentIds : []);
  if (userIds.length === 0 && agentIds.length === 0) {
    throw new Error("Missing member ids.");
  }

  assertWorkspaceRoleForContext(workspaceContext, "admin");

  for (const targetUserId of userIds) {
    addWorkspaceMemberToChannelForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName: input.channelName.trim(),
      targetUserId,
      actor: {
        userId: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        role: workspaceContext.currentMembership.role,
      },
    });
  }
  for (const agentId of agentIds) {
    assertCanUseEmployeeForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      employeeName: agentId,
      actorUserId: workspaceContext.currentUser.id,
    });
  }
  if (agentIds.length > 0) {
    addChannelEmployeesSync({
      channelName: input.channelName.trim(),
      employeeNames: agentIds,
    }, workspaceContext.currentWorkspace.id);
  }

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/settings/permissions"]);
}

export async function inviteExternalContactToChannelAction(input: {
  channelName: string;
  email: string;
}): Promise<{ invitationId: string; invitePath: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.channelName, "channel name");
  assertRequired(input.email, "email");

  const invitation = inviteUserToChannelForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName: input.channelName.trim(),
    inviteeEmail: input.email.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/contacts", "/im", "/settings/permissions"]);
  return {
    invitationId: invitation.id,
    invitePath: `/channel-invite/${encodeURIComponent(invitation.id)}`,
  };
}

export async function revokeChannelInvitationAction(invitationId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(invitationId, "invitation id");

  revokeChannelInvitationForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    invitationId: invitationId.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/contacts", "/settings/permissions"]);
}

export async function deleteChannelAction(channelName: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  if (!channelName.trim()) {
    throw new Error("Missing channel name.");
  }

  deleteChannelSync(channelName.trim(), workspaceContext.currentWorkspace.id);

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents", "/automations"]);
}

export async function renameChannelAction(input: {
  channelName: string;
  nextName: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!input.channelName.trim()) {
    throw new Error("Missing channel name.");
  }
  if (!input.nextName.trim()) {
    throw new Error("Missing next channel name.");
  }

  const channelName = input.channelName.trim();
  assertChannelAccess(workspaceContext, channelName);
  const state = readWorkspaceStateSync(workspaceContext.currentWorkspace.id);
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (channel?.kind === "direct") {
    throw new Error("Cannot rename direct channel.");
  }

  renameChannelSync(channelName, input.nextName.trim(), workspaceContext.currentWorkspace.id);

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
}

export async function sendChannelMessageAction(formData: FormData): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const channelName = getRequiredValue(formData, "channelName");
  const content = getRequiredValue(formData, "content");
  const replyToMessageId = formData.get("replyToMessageId") as string | null;
  const uploadedAttachments = await persistFormAttachments(formData, "attachments", workspaceContext.currentWorkspace.id);
  const attachmentReferenceIds = getStringValues(formData, "attachmentReferences");
  const skillReferenceIds = getStringValues(formData, "skillReferences");

  if (!channelName.trim()) {
    throw new Error("Missing channel name.");
  }
  if (!content.trim()) {
    throw new Error("Missing message content.");
  }
  assertChannelAccess(workspaceContext, channelName);
  const state = readWorkspaceStateSync(workspaceContext.currentWorkspace.id);
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (!channel) {
    throw new Error(`Channel "${channelName}" does not exist.`);
  }
  const referencedAttachments = resolveReferencedAttachments({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName,
    attachmentIds: attachmentReferenceIds,
  });
  const attachments = mergeMessageAttachments(uploadedAttachments, referencedAttachments);
  const resolvedContent = appendReferencedSkillDirective({
    workspaceId: workspaceContext.currentWorkspace.id,
    employeeNames: channel.employeeNames,
    content,
    skillIds: skillReferenceIds,
  });

  const modelCommand = parseModelCommand(resolvedContent);
  if (modelCommand) {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
    const validation = await validateRequestedChatModelOverride({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName: channelName.trim(),
      humanMemberName: workspaceContext.currentUser.displayName.trim() || "你",
      content: modelCommand.remainingContent,
      modelId: modelCommand.modelId,
    });
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    setSessionModelOverrideForChatCommandSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName: channelName.trim(),
      humanMemberName: workspaceContext.currentUser.displayName.trim() || "你",
      content: modelCommand.remainingContent,
      modelId: validation.modelId,
    });
    revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
    return;
  }

  sendChannelHumanMessageSync(
    channelName.trim(),
    workspaceContext.currentUser.displayName.trim() || "你",
    resolvedContent.trim(),
    attachments,
    replyToMessageId?.trim() || undefined,
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
  );

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
}

export async function deleteChannelAttachmentAction(input: {
  channelName: string;
  attachmentId: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.channelName, "channel name");
  assertRequired(input.attachmentId, "attachment id");
  assertChannelAccess(workspaceContext, input.channelName);

  deleteChannelAttachmentSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName: input.channelName.trim(),
    attachmentId: input.attachmentId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    actorDisplayName: workspaceContext.currentUser.displayName.trim() || "你",
  });

  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function sendContactMessageAction(formData: FormData): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const contactId = getRequiredValue(formData, "contactId");
  const content = getRequiredValue(formData, "content");
  const uploadedAttachments = await persistFormAttachments(formData, "attachments", workspaceContext.currentWorkspace.id);
  const attachmentReferenceIds = getStringValues(formData, "attachmentReferences");
  const skillReferenceIds = getStringValues(formData, "skillReferences");
  const referenceChannelName = getOptionalStringValue(formData, "referenceChannelName");
  const humanMemberName = workspaceContext.currentUser.displayName.trim() || "你";
  let referencedAttachments: MessageAttachment[] = [];
  if (attachmentReferenceIds.length > 0) {
    if (!referenceChannelName) {
      throw new Error("Missing referenceChannelName.");
    }
    assertChannelAccess(workspaceContext, referenceChannelName);
    const state = readWorkspaceStateSync(workspaceContext.currentWorkspace.id);
    const referenceChannel = state.channels.find((item) => sameValue(item.name, referenceChannelName));
    if (
      !referenceChannel ||
      referenceChannel.kind !== "direct" ||
      !referenceChannel.employeeNames.some((employeeName) => sameValue(employeeName, contactId))
    ) {
      throw new Error("Attachment references must belong to the selected direct conversation.");
    }
    referencedAttachments = resolveReferencedAttachments({
      workspaceId: workspaceContext.currentWorkspace.id,
      channelName: referenceChannelName,
      attachmentIds: attachmentReferenceIds,
    });
  }
  const attachments = mergeMessageAttachments(uploadedAttachments, referencedAttachments);
  const resolvedContent = appendReferencedSkillDirective({
    workspaceId: workspaceContext.currentWorkspace.id,
    employeeNames: [contactId],
    content,
    skillIds: skillReferenceIds,
  });

  const modelCommand = parseModelCommand(resolvedContent);
  if (modelCommand) {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
    const validation = await validateRequestedChatModelOverride({
      workspaceId: workspaceContext.currentWorkspace.id,
      contactId: contactId.trim(),
      humanMemberName,
      content: modelCommand.remainingContent,
      modelId: modelCommand.modelId,
    });
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    setSessionModelOverrideForChatCommandSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      contactId: contactId.trim(),
      humanMemberName,
      content: modelCommand.remainingContent,
      modelId: validation.modelId,
    });
    revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
    return;
  }

  sendContactMessageForHumanWithAttachmentsSync(
    humanMemberName,
    contactId.trim(),
    resolvedContent.trim(),
    attachments,
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
  );

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
}

export async function getChatModelOverrideAction(input: {
  contactId?: string;
  channelName?: string;
  content?: string;
}): Promise<Awaited<ReturnType<typeof resolveChatModelOverrideAsync>> | null> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (resolveAgentRuntimeMode() !== "remote") {
    return null;
  }

  return resolveChatModelOverrideAsync({
    workspaceId: workspaceContext.currentWorkspace.id,
    humanMemberName: workspaceContext.currentUser.displayName.trim() || "你",
    contactId: input.contactId?.trim(),
    channelName: input.channelName?.trim(),
    content: input.content?.trim(),
  });
}

export async function setChatModelOverrideAction(input: {
  contactId?: string;
  channelName?: string;
  content?: string;
  modelId?: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const validation = await validateRequestedChatModelOverride({
    workspaceId: workspaceContext.currentWorkspace.id,
    humanMemberName: workspaceContext.currentUser.displayName.trim() || "你",
    contactId: input.contactId?.trim(),
    channelName: input.channelName?.trim(),
    content: input.content?.trim() ?? "",
    modelId: input.modelId?.trim(),
  });

  if (!validation.ok) {
    return validation;
  }

  setSessionModelOverrideForChatCommandSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    humanMemberName: workspaceContext.currentUser.displayName.trim() || "你",
    contactId: input.contactId?.trim(),
    channelName: input.channelName?.trim(),
    content: input.content?.trim() ?? "",
    modelId: validation.modelId,
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
  return { ok: true };
}

async function validateRequestedChatModelOverride(input: {
  workspaceId: string;
  humanMemberName: string;
  content: string;
  channelName?: string;
  contactId?: string;
  modelId?: string;
}): Promise<{ ok: true; modelId?: string } | { ok: false; code: string; message: string }> {
  if (resolveAgentRuntimeMode() !== "remote") {
    return { ok: false, code: "remote_mode_required", message: "Model overrides are only available in remote mode." };
  }
  const requestedModelId = input.modelId?.trim();
  if (!requestedModelId || requestedModelId.toLowerCase() === "clear") {
    return { ok: true, modelId: undefined };
  }
  try {
    const validated = await validateSessionModelOverrideForChatCommandAsync(input);
    return { ok: true, modelId: validated.modelId };
  } catch (error) {
    if (error instanceof ChatModelOverrideValidationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendHumanDirectMessageAction(formData: FormData): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const targetUserId = getRequiredValue(formData, "targetUserId");
  const content = getRequiredValue(formData, "content");
  const replyToMessageId = formData.get("replyToMessageId") as string | null;
  const attachments = await persistFormAttachments(formData, "attachments", workspaceContext.currentWorkspace.id);

  sendHumanDirectMessageSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    targetUserId,
    content,
    attachments,
    replyToMessageId: replyToMessageId?.trim() || undefined,
  });

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/contacts", "/im", "/inbox"]);
}

export async function updateDigitalContactRemarkAction(input: {
  contactId: string;
  remarkName: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.contactId, "contact id");

  updateEmployeeRemarkNameSync(
    input.contactId.trim(),
    input.remarkName.trim(),
    workspaceContext.currentWorkspace.id,
  );

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/contacts", "/agents", "/inbox"]);
}

export async function pinMessageAction(messageId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(messageId, "message id");
  const channelName = findMessageChannelName(workspaceContext.currentWorkspace.id, messageId.trim());
  assertChannelAccess(workspaceContext, channelName);
  pinMessageSync(
    messageId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentUser.id,
  );
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function unpinMessageAction(messageId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(messageId, "message id");
  const channelName = findMessageChannelName(workspaceContext.currentWorkspace.id, messageId.trim());
  assertChannelAccess(workspaceContext, channelName);
  unpinMessageSync(
    messageId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentUser.id,
  );
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function acknowledgeMessageAction(messageId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(messageId, "message id");
  const channelName = findMessageChannelName(workspaceContext.currentWorkspace.id, messageId.trim());
  assertChannelAccess(workspaceContext, channelName);
  acknowledgeMessageSync(
    messageId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentUser.id,
  );
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function touchChannelDocumentPresenceAction(input: {
  documentId: string;
  status: "viewing" | "editing";
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
  upsertChannelDocumentPresenceSync({
    documentId: input.documentId.trim(),
    actorId: actorName,
    actorType: "human",
    status: input.status,
  }, workspaceContext.currentWorkspace.id);
}

export async function saveChannelDocumentAction(input: {
  documentId?: string;
  baseVersionId?: string;
  channelName: string;
  title: string;
  contentMarkdown: string;
  summary?: string;
  kind?: "markdown" | "sheet" | "deck";
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";

  assertRequired(input.channelName, "channel name");
  assertRequired(input.title, "document title");
  assertChannelAccess(workspaceContext, input.channelName);

  if (input.documentId && input.documentId.trim().length > 0) {
    assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
    const { document } = updateChannelDocumentSync({
      documentId: input.documentId.trim(),
      title: input.title.trim(),
      contentMarkdown: input.contentMarkdown,
      summary: input.summary,
      updatedBy: actorName,
      updatedByType: "human",
      baseVersionId: input.baseVersionId?.trim() || undefined,
      triggerType: "manual",
    }, workspaceContext.currentWorkspace.id);
    upsertChannelDocumentPresenceSync({
      documentId: document.id,
      actorId: actorName,
      actorType: "human",
      status: "viewing",
    }, workspaceContext.currentWorkspace.id);
    revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
    return { documentId: document.id };
  }

  const { document } = createChannelDocumentSync({
    channelName: input.channelName.trim(),
    title: input.title.trim(),
    kind: input.kind ?? "markdown",
    contentMarkdown: input.contentMarkdown,
    summary: input.summary,
    createdBy: actorName,
    createdByType: "human",
    triggerType: "manual",
  }, workspaceContext.currentWorkspace.id);
  upsertChannelDocumentPresenceSync({
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    status: "viewing",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function rollbackChannelDocumentVersionAction(input: {
  documentId: string;
  versionId: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.documentId, "document id");
  assertRequired(input.versionId, "version id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
  const { document } = rollbackChannelDocumentVersionSync({
    documentId: input.documentId.trim(),
    versionId: input.versionId.trim(),
    updatedBy: actorName,
    updatedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  upsertChannelDocumentPresenceSync({
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    status: "viewing",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function exportChannelDocumentAttachmentAction(documentId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  exportChannelDocumentAsAttachmentSync({
    documentId: documentId.trim(),
    exportedBy: actorName,
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function createChannelDocumentFromAttachmentAction(input: {
  channelName: string;
  attachmentId: string;
  title?: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.channelName, "channel name");
  assertRequired(input.attachmentId, "attachment id");
  assertChannelAccess(workspaceContext, input.channelName);
  const { document } = createChannelDocumentFromAttachmentSync({
    channelName: input.channelName.trim(),
    attachmentId: input.attachmentId.trim(),
    title: input.title,
    createdBy: actorName,
    createdByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function archiveChannelDocumentAction(documentId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  archiveChannelDocumentSync({
    documentId: documentId.trim(),
    archivedBy: actorName,
    archivedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function restoreChannelDocumentAction(documentId: string): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  restoreChannelDocumentSync({
    documentId: documentId.trim(),
    restoredBy: actorName,
    restoredByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: documentId.trim() };
}

export async function resolveChannelDocumentConflictAction(conflictId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(conflictId, "conflict id");
  const documentId = findConflictDocumentId(workspaceContext.currentWorkspace.id, conflictId.trim());
  if (documentId) {
    assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  }
  resolveChannelDocumentConflictSync({
    conflictId: conflictId.trim(),
    resolvedBy: actorName,
    resolvedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function retryChannelDocumentConflictAction(conflictId: string): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(conflictId, "conflict id");
  const documentId = findConflictDocumentId(workspaceContext.currentWorkspace.id, conflictId.trim());
  if (documentId) {
    assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  }
  const { document } = retryChannelDocumentConflictSync({
    conflictId: conflictId.trim(),
    retriedBy: actorName,
    retriedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function updateChannelDocumentAccessRoleAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.documentId, "document id");
  assertRequired(input.actorId, "actor id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
  updateChannelDocumentAccessRoleSync({
    documentId: input.documentId.trim(),
    actorId: input.actorId.trim(),
    actorType: input.actorType,
    role: input.role,
    changedBy: actorName,
    changedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function addChannelDocumentCollaboratorAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.documentId, "document id");
  assertRequired(input.actorId, "actor id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
  addChannelDocumentCollaboratorSync({
    documentId: input.documentId.trim(),
    actorId: input.actorId.trim(),
    actorType: input.actorType,
    role: input.role,
    addedBy: actorName,
    addedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function removeChannelDocumentCollaboratorAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(input.documentId, "document id");
  assertRequired(input.actorId, "actor id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, input.documentId);
  removeChannelDocumentCollaboratorSync({
    documentId: input.documentId.trim(),
    actorId: input.actorId.trim(),
    actorType: input.actorType,
    removedBy: actorName,
    removedByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

function getRequiredValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value.trim();
}

function getOptionalStringValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStringValues(formData: FormData, key: string): string[] {
  return dedupeStrings(formData.getAll(key).filter((value): value is string => typeof value === "string"));
}

function resolveReferencedAttachments(input: {
  workspaceId: string;
  channelName: string;
  attachmentIds: string[];
}): MessageAttachment[] {
  if (input.attachmentIds.length === 0) {
    return [];
  }
  const requestedIds = new Set(input.attachmentIds);
  const attachmentsById = new Map<string, MessageAttachment>();
  for (const message of readWorkspaceStateSync(input.workspaceId).messages) {
    if (!sameValue(message.channel ?? "", input.channelName)) {
      continue;
    }
    for (const attachment of message.attachments ?? []) {
      if (requestedIds.has(attachment.id) && !attachment.deletedAt && !attachmentsById.has(attachment.id)) {
        attachmentsById.set(attachment.id, attachment);
      }
    }
  }
  return input.attachmentIds.map((attachmentId) => {
    const attachment = attachmentsById.get(attachmentId);
    if (!attachment) {
      throw new Error(`Attachment "${attachmentId}" does not exist in channel "${input.channelName}".`);
    }
    const { deletedAt: _deletedAt, deletedByDisplayName: _deletedByDisplayName, deletedByUserId: _deletedByUserId, ...activeAttachment } = attachment;
    return {
      ...activeAttachment,
      id: `att-ref-${crypto.randomUUID()}`,
    };
  });
}

function mergeMessageAttachments(
  uploaded: MessageAttachment[] | undefined,
  referenced: MessageAttachment[],
): MessageAttachment[] | undefined {
  const attachments = [...(uploaded ?? []), ...referenced];
  return attachments.length > 0 ? attachments : undefined;
}

function appendReferencedSkillDirective(input: {
  workspaceId: string;
  employeeNames: string[];
  content: string;
  skillIds: string[];
}): string {
  if (input.skillIds.length === 0) {
    return input.content;
  }
  const allowedSkillIds = new Set(
    input.employeeNames.flatMap((employeeName) => listEmployeeSkillIdsSync(employeeName, input.workspaceId)),
  );
  const skillsById = new Map(listWorkspaceSkillsSync(input.workspaceId).map((skill) => [skill.id, skill]));
  const skillNames = input.skillIds.map((skillId) => {
    const skill = skillsById.get(skillId);
    if (!skill || !allowedSkillIds.has(skillId)) {
      throw new Error(`Skill "${skillId}" is not assigned to the selected employee.`);
    }
    return skill.name;
  });
  return `${input.content.trim()}\n\n[Use assigned skills: ${skillNames.join(", ")}]`;
}

function parseQueuedTaskPayload(inputJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}

async function requireActionWorkspaceContext(workspaceIdentifier?: string): Promise<Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const targetWorkspaceIdentifier = workspaceIdentifier?.trim();
  if (
    !targetWorkspaceIdentifier
    || targetWorkspaceIdentifier === workspaceContext.currentWorkspace.id
    || targetWorkspaceIdentifier === workspaceContext.currentWorkspace.slug
  ) {
    return workspaceContext;
  }

  const resolution = resolveWorkspaceAccessForIdentifierSync(
    workspaceContext.currentUser,
    targetWorkspaceIdentifier,
  );
  if (resolution.status !== "ok" || resolution.context.accessScope !== "workspace") {
    throw new Error("Forbidden.");
  }
  return resolution.context;
}

function revalidateChannelRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/im", "/inbox", "/agents", "/contacts"]);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function assertChannelAccess(
  workspaceContext: Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>,
  channelName?: string,
): void {
  const visibility = getWorkspaceChannelVisibilitySync(
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.displayName,
    {
      userId: workspaceContext.currentUser.id,
      role: workspaceContext.currentMembership.role,
    },
  );
  if (!visibility.canAccessChannel(channelName)) {
    throw new Error("Forbidden.");
  }
}

function findMessageChannelName(workspaceId: string, messageId: string): string | undefined {
  const state = readWorkspaceStateSync(workspaceId);
  return state.messages.find((message) => sameValue(message.id, messageId))?.channel;
}

function assertDocumentChannelAccess(workspaceId: string, currentUserDisplayName: string, documentId: string): void {
  if (!canViewChannelDocumentSync(documentId.trim(), currentUserDisplayName, "human", workspaceId)) {
    throw new Error("Forbidden.");
  }
}

function findConflictDocumentId(workspaceId: string, conflictId: string): string | undefined {
  return readWorkspaceStateSync(workspaceId).channelDocumentConflicts.find((conflict) => sameValue(conflict.id, conflictId))?.documentId;
}

function buildInlineApprovalInvalidation(workspaceId: string, approvalId: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["im", "approvals", "inbox", "agents"],
    resources: [{ type: "approval", id: approvalId }],
    shell: "counters",
  };
}
