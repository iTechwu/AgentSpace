"use server";

import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { resolveWorkspaceAccessForIdentifierSync } from "@/features/auth/server-workspace-resolver";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { getWorkspaceChannelVisibilitySync } from "@/features/auth/workspace-channel-visibility";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import { revokeGoogleOAuthCredentialSync } from "@agent-space/db";
import type { ChannelDocumentAccessRole } from "@agent-space/domain";
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
  createExternalGoogleDocChannelDocumentSync,
  createExternalGoogleSheetChannelDocumentSync,
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
  readChannelDocumentSync,
  readWorkspaceStateSync,
  recordExternalSheetOperationRunSync,
  rejectChannelAccessRequestForActorSync,
  requestChannelAccessForActorSync,
  revokeChannelInvitationForActorSync,
  sameValue,
  unpinMessageSync,
  updateEmployeeRemarkNameSync,
  updateExternalChannelDocumentMetadataSync,
  updateExternalSheetOperationRunSync,
  upsertChannelDocumentPresenceSync,
  updateChannelDocumentSync,
  reviewApprovalSync,
} from "@agent-space/services";
import { persistFormAttachments } from "@/features/chat/attachment-actions";
import type { ChannelDocument, ExternalDocumentSyncStatus } from "@agent-space/domain/workspace";
import {
  createGoogleWorkspaceDoc,
  createGoogleWorkspaceSheet,
  getGoogleWorkspaceAccessTokenForUser,
  GoogleWorkspaceApiError,
  readGoogleDriveFileMetadata,
  readGoogleWorkspaceOAuthConfig,
} from "@/features/integrations/google-workspace";
import { syncGoogleSheetDocumentDrivePermissions } from "@/features/integrations/google-drive-permissions";
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/access", "/inbox"]);
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/access"]);
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/approvals", "/settings/access"]);
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/settings/access"]);
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/contacts", "/im", "/settings/access"]);
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

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/contacts", "/settings/access"]);
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
  const attachments = await persistFormAttachments(formData, "attachments", workspaceContext.currentWorkspace.id);

  if (!channelName.trim()) {
    throw new Error("Missing channel name.");
  }
  if (!content.trim()) {
    throw new Error("Missing message content.");
  }
  assertChannelAccess(workspaceContext, channelName);

  sendChannelHumanMessageSync(
    channelName.trim(),
    workspaceContext.currentUser.displayName.trim() || "你",
    content.trim(),
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
  const attachments = await persistFormAttachments(formData, "attachments", workspaceContext.currentWorkspace.id);
  const humanMemberName = workspaceContext.currentUser.displayName.trim() || "你";

  sendContactMessageForHumanWithAttachmentsSync(
    humanMemberName,
    contactId.trim(),
    content.trim(),
    attachments,
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
  );

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/im", "/inbox", "/agents"]);
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

export async function createExternalGoogleSheetDocumentAction(input: {
  channelName: string;
  title: string;
  externalUrl: string;
  externalFileId?: string;
  summary?: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";

  assertRequired(input.channelName, "channel name");
  assertRequired(input.title, "document title");
  assertRequired(input.externalUrl, "Google Sheet URL");
  assertChannelAccess(workspaceContext, input.channelName);

  const externalUrl = input.externalUrl.trim();
  const externalFileId = input.externalFileId?.trim() || parseGoogleSheetFileId(externalUrl);
  if (!externalFileId) {
    throw new Error("Could not read a Google Sheet file id from that URL.");
  }

  const { accessToken, credential } = await getGoogleWorkspaceAccessTokenForUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    userId: workspaceContext.currentUser.id,
  });
  const metadata = await readGoogleDriveFileMetadata({
    accessToken,
    fileId: externalFileId,
  });

  const { document } = createExternalGoogleSheetChannelDocumentSync({
    channelName: input.channelName.trim(),
    title: input.title.trim(),
    externalFileId,
    externalUrl: metadata.webViewLink || externalUrl,
    externalMimeType: metadata.mimeType,
    externalUpdatedAt: metadata.modifiedTime,
    summary: input.summary,
    createdBy: actorName,
    createdByType: "human",
  }, workspaceContext.currentWorkspace.id);
  upsertChannelDocumentPresenceSync({
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    status: "viewing",
  }, workspaceContext.currentWorkspace.id);
  await syncGoogleSheetDocumentDrivePermissions({
    accessToken,
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    skipEmails: [
      workspaceContext.currentUser.email,
      credential?.googleEmail,
    ].filter((email): email is string => Boolean(email)),
  });
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function createGoogleSheetDocumentAction(input: {
  channelName: string;
  title: string;
  summary?: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";

  assertRequired(input.channelName, "channel name");
  assertRequired(input.title, "document title");
  assertChannelAccess(workspaceContext, input.channelName);

  const { accessToken, credential } = await getGoogleWorkspaceAccessTokenForUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    userId: workspaceContext.currentUser.id,
  });
  const googleConfig = readGoogleWorkspaceOAuthConfig();
  const file = await createGoogleWorkspaceSheet({
    accessToken,
    name: input.title.trim(),
    parentFolderId: googleConfig.driveParentFolderId,
  });

  const { document } = createExternalGoogleSheetChannelDocumentSync({
    channelName: input.channelName.trim(),
    title: input.title.trim(),
    externalFileId: file.id,
    externalUrl: file.webViewLink,
    externalMimeType: file.mimeType,
    externalUpdatedAt: file.modifiedTime,
    summary: input.summary,
    createdBy: actorName,
    createdByType: "human",
  }, workspaceContext.currentWorkspace.id);
  upsertChannelDocumentPresenceSync({
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    status: "viewing",
  }, workspaceContext.currentWorkspace.id);
  await syncGoogleSheetDocumentDrivePermissions({
    accessToken,
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    skipEmails: [
      workspaceContext.currentUser.email,
      credential?.googleEmail,
    ].filter((email): email is string => Boolean(email)),
  });
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function createExternalGoogleDocDocumentAction(input: {
  channelName: string;
  title: string;
  externalUrl: string;
  externalFileId?: string;
  summary?: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";

  assertRequired(input.channelName, "channel name");
  assertRequired(input.title, "document title");
  assertRequired(input.externalUrl, "Google Doc URL");
  assertChannelAccess(workspaceContext, input.channelName);

  const externalUrl = input.externalUrl.trim();
  const externalFileId = input.externalFileId?.trim() || parseGoogleDocFileId(externalUrl);
  if (!externalFileId) {
    throw new Error("Could not read a Google Doc file id from that URL.");
  }

  const { document } = createExternalGoogleDocChannelDocumentSync({
    channelName: input.channelName.trim(),
    title: input.title.trim(),
    externalFileId,
    externalUrl,
    summary: input.summary,
    createdBy: actorName,
    createdByType: "human",
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

export async function createGoogleDocDocumentAction(input: {
  channelName: string;
  title: string;
  summary?: string;
}): Promise<{ documentId: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";

  assertRequired(input.channelName, "channel name");
  assertRequired(input.title, "document title");
  assertChannelAccess(workspaceContext, input.channelName);

  const { accessToken, credential } = await getGoogleWorkspaceAccessTokenForUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    userId: workspaceContext.currentUser.id,
  });
  const file = await createGoogleWorkspaceDoc({
    accessToken,
    title: input.title.trim(),
  });

  const { document } = createExternalGoogleDocChannelDocumentSync({
    channelName: input.channelName.trim(),
    title: input.title.trim(),
    externalFileId: file.id,
    externalUrl: file.webViewLink,
    externalMimeType: file.mimeType,
    externalUpdatedAt: file.modifiedTime,
    summary: input.summary,
    createdBy: actorName,
    createdByType: "human",
  }, workspaceContext.currentWorkspace.id);
  upsertChannelDocumentPresenceSync({
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    status: "viewing",
  }, workspaceContext.currentWorkspace.id);
  await syncGoogleSheetDocumentDrivePermissions({
    accessToken,
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: document.id,
    actorId: actorName,
    actorType: "human",
    skipEmails: [
      workspaceContext.currentUser.email,
      credential?.googleEmail,
    ].filter((email): email is string => Boolean(email)),
  });
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
  return { documentId: document.id };
}

export async function refreshExternalGoogleSheetDocumentAction(documentId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);

  const { document } = readChannelDocumentSync(documentId.trim(), workspaceContext.currentWorkspace.id);
  assertExternalGoogleSheetDocument(document);
  const run = recordExternalSheetOperationRunSync({
    channelDocumentId: document.id,
    actorType: "human",
    actorId: actorName,
    status: "running",
    intent: "Refresh Google Sheet metadata",
    operationType: "metadata_refresh",
    requestSummary: "Read Google Drive file metadata and update agent.dofe external status.",
  }, workspaceContext.currentWorkspace.id);

  try {
    const { accessToken } = await getGoogleWorkspaceAccessTokenForUser({
      workspaceId: workspaceContext.currentWorkspace.id,
      userId: workspaceContext.currentUser.id,
    });
    const metadata = await readGoogleDriveFileMetadata({
      accessToken,
      fileId: document.externalFileId ?? "",
    });
    updateExternalChannelDocumentMetadataSync({
      documentId: document.id,
      externalSyncStatus: "ok",
      externalMimeType: metadata.mimeType,
      externalUpdatedAt: metadata.modifiedTime,
      updatedBy: actorName,
    }, workspaceContext.currentWorkspace.id);
    updateExternalSheetOperationRunSync({
      runId: run.id,
      status: "succeeded",
      responseSummary: `Google Drive reports "${metadata.name}" updated at ${metadata.modifiedTime ?? "unknown time"}.`,
    }, workspaceContext.currentWorkspace.id);
  } catch (error) {
    const nextSyncStatus = resolveExternalSheetStatusFromError(error);
    updateExternalChannelDocumentMetadataSync({
      documentId: document.id,
      externalSyncStatus: nextSyncStatus,
      updatedBy: actorName,
    }, workspaceContext.currentWorkspace.id);
    updateExternalSheetOperationRunSync({
      runId: run.id,
      status: "failed",
      errorCode: error instanceof GoogleWorkspaceApiError ? error.code : error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    }, workspaceContext.currentWorkspace.id);
  }

  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function syncExternalGoogleSheetPermissionsAction(documentId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const actorName = workspaceContext.currentUser.displayName.trim() || "你";
  assertRequired(documentId, "document id");
  assertDocumentChannelAccess(workspaceContext.currentWorkspace.id, workspaceContext.currentUser.displayName, documentId);
  await syncExternalGoogleSheetPermissionsForCurrentUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: documentId.trim(),
    actorId: actorName,
    userId: workspaceContext.currentUser.id,
    userEmail: workspaceContext.currentUser.email,
  });
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

export async function disconnectGoogleWorkspaceAction(): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  try {
    revokeGoogleOAuthCredentialSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      userId: workspaceContext.currentUser.id,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Google OAuth credential does not exist.") {
      throw error;
    }
  }
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
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
  await syncExternalGoogleSheetPermissionsForCurrentUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: input.documentId.trim(),
    actorId: actorName,
    userId: workspaceContext.currentUser.id,
    userEmail: workspaceContext.currentUser.email,
  });
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
  await syncExternalGoogleSheetPermissionsForCurrentUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: input.documentId.trim(),
    actorId: actorName,
    userId: workspaceContext.currentUser.id,
    userEmail: workspaceContext.currentUser.email,
  });
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
  await syncExternalGoogleSheetPermissionsForCurrentUser({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: input.documentId.trim(),
    actorId: actorName,
    userId: workspaceContext.currentUser.id,
    userEmail: workspaceContext.currentUser.email,
  });
  revalidateChannelRoutes(workspaceContext.currentWorkspace.slug);
}

function getRequiredValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value.trim();
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

function assertExternalGoogleSheetDocument(document: ChannelDocument): void {
  if (
    document.kind !== "sheet" ||
    document.storageMode !== "external" ||
    document.externalProvider !== "google_workspace" ||
    !document.externalFileId ||
    !document.externalUrl
  ) {
    throw new Error(`Channel document "${document.title}" is not an external Google Sheet.`);
  }
}

async function syncExternalGoogleSheetPermissionsForCurrentUser(input: {
  workspaceId: string;
  documentId: string;
  actorId: string;
  userId: string;
  userEmail?: string;
}): Promise<void> {
  const { document } = readChannelDocumentSync(input.documentId, input.workspaceId);
  if (
    document.kind !== "sheet" ||
    document.storageMode !== "external" ||
    document.externalProvider !== "google_workspace"
  ) {
    return;
  }

  try {
    const { accessToken, credential } = await getGoogleWorkspaceAccessTokenForUser({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    await syncGoogleSheetDocumentDrivePermissions({
      accessToken,
      workspaceId: input.workspaceId,
      documentId: document.id,
      actorId: input.actorId,
      actorType: "human",
      skipEmails: [
        input.userEmail,
        credential?.googleEmail,
      ].filter((email): email is string => Boolean(email)),
    });
  } catch (error) {
    recordExternalSheetOperationRunSync({
      channelDocumentId: document.id,
      actorType: "human",
      actorId: input.actorId,
      status: "failed",
      intent: "Sync Google Drive permissions for external sheet",
      operationType: "share",
      requestSummary: "Sync Drive permissions after agent.dofe collaborator change.",
      errorCode: error instanceof GoogleWorkspaceApiError ? error.code : error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    }, input.workspaceId);
  }
}

function resolveExternalSheetStatusFromError(error: unknown): ExternalDocumentSyncStatus {
  if (error instanceof GoogleWorkspaceApiError) {
    if (error.status === 404) {
      return "missing";
    }
    if (error.status === 401 || error.status === 403) {
      return "permission_error";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "google_workspace.not_connected" || message === "google_workspace.reconnect_required") {
    return "permission_error";
  }
  return "unknown";
}

function parseGoogleSheetFileId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([^/?#]+)/);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return "";
}

function parseGoogleDocFileId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/document\/d\/([^/?#]+)/);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return "";
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
