"use server";

import {
  approveAgentAccessRequestForActorSync,
  approveDocumentPermissionRequestSync,
  grantDocumentAgentAccessSync,
  removeWorkspaceMemberFromChannelForActorSync,
  rejectAgentAccessRequestForActorSync,
  rejectDocumentPermissionRequestSync,
  revokeDocumentAgentAccessSync,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import type { WorkspaceRole } from "@dofe-agent/db";
import type { ChannelDocumentAccessRole } from "@dofe-agent/domain";
import {
  bindWorkspaceAgentRuntimeAction,
  grantWorkspaceRuntimeUseAction,
  revokeWorkspaceRuntimeUseAction,
  setWorkspaceAgentChannelMemberAccessAction,
  setWorkspaceAgentKnowledgeAssignmentsAction,
  setWorkspaceAgentSkillAssignmentsAction,
  unbindWorkspaceAgentRuntimeAction,
} from "@/features/agents/actions";
import {
  addChannelDocumentCollaboratorAction,
  addWorkspaceMembersToChannelAction,
  approveChannelAccessRequestAction,
  rejectChannelAccessRequestAction,
  removeChannelDocumentCollaboratorAction,
  revokeChannelInvitationAction,
  updateChannelDocumentAccessRoleAction,
} from "@/features/channels/actions";
import {
  createDaemonApiTokenAction,
  createWorkspaceInvitationAction,
  removeWorkspaceMemberAction,
  reissueWorkspaceInvitationAction,
  revokeDaemonApiTokenAction,
  revokeWorkspaceInvitationAction,
  transferWorkspaceOwnershipAction,
  updateWorkspaceMemberRoleAction,
} from "@/features/settings/actions";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";

const PERMISSION_REVALIDATE_PATHS = [
  "/settings/permissions",
  "/settings/access",
  "/settings/members",
  "/agents",
  "/knowledge",
  "/skills",
  "/im",
] as const;

export async function permissionsCreateWorkspaceInvitationAction(input: {
  email: string;
  role: WorkspaceRole;
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await createWorkspaceInvitationAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsReissueWorkspaceInvitationAction(invitationId: string) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await reissueWorkspaceInvitationAction(invitationId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsRevokeWorkspaceInvitationAction(invitationId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await revokeWorkspaceInvitationAction(invitationId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsUpdateWorkspaceMemberRoleAction(input: {
  userId: string;
  role: WorkspaceRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await updateWorkspaceMemberRoleAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRemoveWorkspaceMemberAction(userId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await removeWorkspaceMemberAction(userId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsTransferWorkspaceOwnershipAction(userId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await transferWorkspaceOwnershipAction(userId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsApproveChannelAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await approveChannelAccessRequestAction(requestId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRejectChannelAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await rejectChannelAccessRequestAction(requestId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRevokeChannelInvitationAction(invitationId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await revokeChannelInvitationAction(invitationId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsAddWorkspaceMemberToChannelAction(input: {
  channelName: string;
  userId: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await addWorkspaceMembersToChannelAction({
    channelName: input.channelName,
    userIds: [input.userId],
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRemoveWorkspaceMemberFromChannelAction(input: {
  channelName: string;
  userId: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertRequired(input.channelName, "channel name");
  assertRequired(input.userId, "user id");

  removeWorkspaceMemberFromChannelForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    channelName: input.channelName.trim(),
    targetUserId: input.userId.trim(),
    actor: {
      userId: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      role: workspaceContext.currentMembership.role,
    },
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Channel participant removed",
    note: `${workspaceContext.currentUser.displayName} removed user "${input.userId.trim()}" from channel "${input.channelName.trim()}".`,
    code: "channel.participant_removed",
    data: {
      actorType: "session_user",
      resourceType: "channel",
      resourceId: input.channelName.trim(),
      targetUserId: input.userId.trim(),
    },
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsGrantRuntimeUseAction(input: {
  runtimeId: string;
  userId: string;
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await grantWorkspaceRuntimeUseAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsRevokeRuntimeUseAction(input: {
  runtimeId: string;
  userId: string;
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await revokeWorkspaceRuntimeUseAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsCreateDaemonApiTokenAction(input: {
  label: string;
  createdBy: string;
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await createDaemonApiTokenAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsRevokeDaemonApiTokenAction(tokenId: string) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await revokeDaemonApiTokenAction(tokenId);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsBindAgentRuntimeAction(input: {
  employeeName: string;
  runtimeId: string;
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await bindWorkspaceAgentRuntimeAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsUnbindAgentRuntimeAction(employeeName: string) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await unbindWorkspaceAgentRuntimeAction(employeeName);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsSetAgentChannelMemberAccessAction(input: {
  employeeName: string;
  channelMemberAccess: "enabled" | "disabled";
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await setWorkspaceAgentChannelMemberAccessAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsSetAgentSkillAssignmentsAction(input: {
  employeeName: string;
  skillIds: string[];
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await setWorkspaceAgentSkillAssignmentsAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsSetAgentKnowledgeAssignmentsAction(input: {
  employeeName: string;
  knowledgePageIds: string[];
}) {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = await setWorkspaceAgentKnowledgeAssignmentsAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
  return result;
}

export async function permissionsUpdateChannelDocumentAccessRoleAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await updateChannelDocumentAccessRoleAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsAddChannelDocumentCollaboratorAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  role: ChannelDocumentAccessRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await addChannelDocumentCollaboratorAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRemoveChannelDocumentCollaboratorAction(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await removeChannelDocumentCollaboratorAction(input);
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsGrantDocumentAgentAccessAction(input: {
  documentId: string;
  agentName: string;
  role: "viewer" | "editor" | "forwarder";
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await grantDocumentAgentAccessSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: input.documentId,
    agentName: input.agentName,
    role: input.role,
    grantedByUserId: workspaceContext.currentUser.id,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRevokeDocumentAgentAccessAction(input: {
  documentId: string;
  agentName: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await revokeDocumentAgentAccessSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    documentId: input.documentId,
    agentName: input.agentName,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsApproveDocumentPermissionRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await approveDocumentPermissionRequestSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId,
    decidedByUserId: workspaceContext.currentUser.id,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRejectDocumentPermissionRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await rejectDocumentPermissionRequestSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId,
    decidedByUserId: workspaceContext.currentUser.id,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsApproveAgentAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await approveAgentAccessRequestForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId,
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

export async function permissionsRejectAgentAccessRequestAction(requestId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  await rejectAgentAccessRequestForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    requestId,
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidatePermissions(workspaceContext.currentWorkspace.slug);
}

function revalidatePermissions(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, [...PERMISSION_REVALIDATE_PATHS]);
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}
