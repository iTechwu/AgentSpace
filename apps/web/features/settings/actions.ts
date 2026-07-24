"use server";

import {
  createWorkspaceInvitationSync,
  listWorkspaceInvitationsSync,
  revokeWorkspaceInvitationSync,
  updateUserSync,
  rotateWorkspaceJoinCodeSync,
  updateWorkspaceSync,
  listWorkspaceMemberUsersSync,
  readUserByEmailSync,
  revokeOtherSessionsForUserSync,
  revokeSessionByIdSync,
  createDaemonApiTokenSync,
  readDaemonApiTokenSync,
  revokeDaemonApiTokenSync,
  type WorkspaceMemberUserRecord,
  type WorkspaceRole,
  transferWorkspaceOwnershipSync,
  upsertWorkspaceMembershipSync,
  updateWorkspaceMembershipRoleSync,
  removeWorkspaceMembershipSync,
  readAuthIdentityForUserSync,
} from "@agent-space/db";
import { addHumanMemberSync, createNotificationSync, tryRecordWorkspaceAuditEventSync } from "@agent-space/services";
import { getCurrentSession } from "@/features/auth/server-auth";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import { SETTINGS_REVALIDATE_PATHS } from "@/features/settings/settings-sections";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

function revalidateSettingsPaths(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, SETTINGS_REVALIDATE_PATHS);
}

function assertLocalWorkspaceManagementAllowed(workspaceId: string): void {
  if (workspaceId.startsWith("sso-")) {
    throw new Error("auth.sso_workspace_managed");
  }
}

export async function createDaemonApiTokenAction(input: {
  label: string;
  createdBy: string;
}): Promise<ActionToastResult<{
  id: string;
  label: string;
  token: string;
}>> {
  const label = input.label.trim();
  const createdBy = input.createdBy.trim();
  if (!label) {
    throw new Error("Missing daemon token label.");
  }
  if (!createdBy) {
    throw new Error("Missing creator name.");
  }

  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const created = createDaemonApiTokenSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    label,
    createdBy: workspaceContext.currentUser.displayName.trim() || createdBy,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Daemon token created",
    note: `Daemon token "${created.label}" was created by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.daemon_token_created",
    data: {
      actorType: "session_user",
      resourceType: "daemon_token",
      resourceId: created.id,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    {
      id: created.id,
      label: created.label,
      token: created.token,
    },
    successToast("服务器令牌已创建。", "Server token created."),
  );
}

export async function revokeDaemonApiTokenAction(tokenId: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  if (!tokenId.trim()) {
    throw new Error("Missing daemon token id.");
  }

  const token = readDaemonApiTokenSync(tokenId.trim());
  if (!token || token.workspaceId !== workspaceContext.currentWorkspace.id) {
    throw new Error("Forbidden.");
  }

  revokeDaemonApiTokenSync(tokenId.trim());
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Daemon token revoked",
    note: `Daemon token "${tokenId.trim()}" was revoked by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.daemon_token_revoked",
    data: {
      actorType: "session_user",
      resourceType: "daemon_token",
      resourceId: tokenId.trim(),
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("服务器令牌已吊销。", "Server token revoked."));
}

export async function revokeSessionAction(sessionId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const currentSession = await getCurrentSession();
  if (!currentSession) {
    throw new Error("Unauthorized.");
  }

  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("Missing session id.");
  }
  if (normalizedSessionId === currentSession.id) {
    throw new Error("Cannot revoke the current session.");
  }

  const revoked = revokeSessionByIdSync(normalizedSessionId, workspaceContext.currentUser.id);
  if (!revoked) {
    throw new Error("Forbidden.");
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Session revoked",
    note: `${workspaceContext.currentUser.displayName} revoked session "${normalizedSessionId}".`,
    code: "auth.session_revoked",
    data: {
      actorType: "session_user",
      resourceType: "auth_session",
      resourceId: normalizedSessionId,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function revokeOtherSessionsAction(): Promise<{ revokedCount: number }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const currentSession = await getCurrentSession();
  if (!currentSession) {
    throw new Error("Unauthorized.");
  }

  const revokedCount = revokeOtherSessionsForUserSync(workspaceContext.currentUser.id, currentSession.id);
  if (revokedCount > 0) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: "Other sessions revoked",
      note: `${workspaceContext.currentUser.displayName} revoked ${revokedCount} other session(s).`,
      code: "auth.other_sessions_revoked",
      data: {
        actorType: "session_user",
        resourceType: "auth_session",
        resourceId: currentSession.id,
        revokedCount,
      },
    });
  }

  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
  return { revokedCount };
}

export async function updateWorkspaceProfileAction(input: {
  name: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "owner");

  const name = input.name.trim();
  if (!name) {
    throw new Error("workspace.profile.missing_name");
  }
  if (name === workspaceContext.currentWorkspace.name) {
    return;
  }

  updateWorkspaceSync(workspaceContext.currentWorkspace.id, { name });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace profile updated",
    note: `${workspaceContext.currentUser.displayName} renamed workspace to "${name}".`,
    code: "workspace.profile_updated",
    data: {
      actorType: "session_user",
      resourceType: "workspace",
      resourceId: workspaceContext.currentWorkspace.id,
      workspaceName: name,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function rotateWorkspaceJoinCodeAction(): Promise<ActionToastResult<{
  joinCode: string;
  updatedAt: string;
}>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "owner");

  const workspace = rotateWorkspaceJoinCodeSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    updatedBy: workspaceContext.currentUser.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace join code rotated",
    note: `${workspaceContext.currentUser.displayName} reset the workspace join code.`,
    code: "workspace.join_code_rotated",
    data: {
      actorType: "session_user",
      resourceType: "workspace",
      resourceId: workspaceContext.currentWorkspace.id,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);

  return actionToastResult({
    joinCode: workspace.joinCode ?? "",
    updatedAt: workspace.joinCodeUpdatedAt ?? new Date().toISOString(),
  }, successToast("工作区邀请码已重置。", "Workspace join code reset."));
}

export async function readCurrentWorkspaceJoinCodeAction(): Promise<{
  joinCode: string;
  updatedAt?: string;
}> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "owner");

  return {
    joinCode: workspaceContext.currentWorkspace.joinCode ?? "",
    updatedAt: workspaceContext.currentWorkspace.joinCodeUpdatedAt,
  };
}

export async function updateCurrentUserProfileAction(input: {
  displayName: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (readAuthIdentityForUserSync(workspaceContext.currentUser.id, "sso")) {
    throw new Error("auth.sso_profile_managed");
  }

  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error("auth.profile.missing_display_name");
  }
  if (displayName === workspaceContext.currentUser.displayName) {
    return;
  }

  updateUserSync({
    userId: workspaceContext.currentUser.id,
    displayName,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "User profile updated",
    note: `${workspaceContext.currentUser.displayName} updated their display name to "${displayName}".`,
    code: "auth.profile_updated",
    data: {
      actorType: "session_user",
      resourceType: "user",
      resourceId: workspaceContext.currentUser.id,
      displayName,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function createWorkspaceInvitationAction(input: {
  email: string;
  role: WorkspaceRole;
}): Promise<{
  id: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
  invitePath: string;
}> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error("workspace.invitation.missing_email");
  }
  if (input.role === "owner" && workspaceContext.currentMembership.role !== "owner") {
    throw new Error("workspace.members.owner_only");
  }

  const created = createWorkspaceInvitationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    email,
    role: input.role,
    invitedBy: workspaceContext.currentUser.id,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace invitation created",
    note: `${workspaceContext.currentUser.displayName} invited ${email} as ${input.role}.`,
    code: "workspace.invitation_created",
    data: {
      actorType: "session_user",
      resourceType: "workspace_invitation",
      resourceId: created.id,
      inviteeEmail: email,
      targetRole: input.role,
    },
  });
  const invitedUser = readUserByEmailSync(email);
  if (invitedUser) {
    createNotificationSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      recipientType: "human",
      recipientId: invitedUser.id,
      actorType: "human",
      actorId: workspaceContext.currentUser.id,
      type: "workspace.invitation_created",
      resourceType: "workspace",
      resourceId: workspaceContext.currentWorkspace.id,
      title: "Workspace invitation",
      body: `${workspaceContext.currentUser.displayName} invited you to ${workspaceContext.currentWorkspace.name} as ${input.role}.`,
      actionHref: "/settings",
      severity: "info",
      dedupeKey: `workspace.invitation_created:${workspaceContext.currentWorkspace.id}:${created.id}:${invitedUser.id}`,
      metadata: {
        invitationId: created.id,
        workspaceName: workspaceContext.currentWorkspace.name,
        inviteeEmail: email,
        targetRole: input.role,
      },
    });
  }
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);

  return {
    id: created.id,
    email: created.email,
    role: created.role,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    invitePath: `/invite/${created.token}`,
  };
}

export async function reissueWorkspaceInvitationAction(invitationId: string): Promise<{
  id: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
  invitePath: string;
}> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const normalizedInvitationId = invitationId.trim();
  if (!normalizedInvitationId) {
    throw new Error("workspace.invitation.not_found");
  }

  const invitations = listWorkspaceInvitationsSync(workspaceContext.currentWorkspace.id, {
    statuses: ["active", "accepted", "revoked", "expired"],
  });
  const invitation = invitations.find((item) => item.id === normalizedInvitationId);
  if (!invitation) {
    throw new Error("workspace.invitation.not_found");
  }
  if (invitation.status === "accepted") {
    throw new Error("workspace.invitation.already_accepted");
  }

  const created = createWorkspaceInvitationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    email: invitation.email,
    role: invitation.role,
    invitedBy: workspaceContext.currentUser.id,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace invitation reissued",
    note: `${workspaceContext.currentUser.displayName} reissued the invitation for ${invitation.email}.`,
    code: "workspace.invitation_reissued",
    data: {
      actorType: "session_user",
      resourceType: "workspace_invitation",
      resourceId: created.id,
      previousInvitationId: invitation.id,
      inviteeEmail: invitation.email,
      targetRole: invitation.role,
    },
  });
  const invitedUser = readUserByEmailSync(invitation.email);
  if (invitedUser) {
    createNotificationSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      recipientType: "human",
      recipientId: invitedUser.id,
      actorType: "human",
      actorId: workspaceContext.currentUser.id,
      type: "workspace.invitation_created",
      resourceType: "workspace",
      resourceId: workspaceContext.currentWorkspace.id,
      title: "Workspace invitation reissued",
      body: `${workspaceContext.currentUser.displayName} reissued your invitation to ${workspaceContext.currentWorkspace.name}.`,
      actionHref: "/settings",
      severity: "info",
      dedupeKey: `workspace.invitation_created:${workspaceContext.currentWorkspace.id}:${created.id}:${invitedUser.id}`,
      metadata: {
        invitationId: created.id,
        previousInvitationId: invitation.id,
        workspaceName: workspaceContext.currentWorkspace.name,
        inviteeEmail: invitation.email,
        targetRole: invitation.role,
      },
    });
  }
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);

  return {
    id: created.id,
    email: created.email,
    role: created.role,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    invitePath: `/invite/${created.token}`,
  };
}

export async function revokeWorkspaceInvitationAction(invitationId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const normalizedInvitationId = invitationId.trim();
  if (!normalizedInvitationId) {
    throw new Error("workspace.invitation.not_found");
  }

  const invitations = listWorkspaceInvitationsSync(workspaceContext.currentWorkspace.id, {
    statuses: ["active", "accepted", "revoked", "expired"],
  });
  const invitation = invitations.find((item) => item.id === normalizedInvitationId);
  if (!invitation) {
    throw new Error("workspace.invitation.not_found");
  }

  revokeWorkspaceInvitationSync(normalizedInvitationId, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace invitation revoked",
    note: `${workspaceContext.currentUser.displayName} revoked invitation for ${invitation.email}.`,
    code: "workspace.invitation_revoked",
    data: {
      actorType: "session_user",
      resourceType: "workspace_invitation",
      resourceId: normalizedInvitationId,
      inviteeEmail: invitation.email,
    },
  });
  const invitedUser = readUserByEmailSync(invitation.email);
  if (invitedUser) {
    createNotificationSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      recipientType: "human",
      recipientId: invitedUser.id,
      actorType: "human",
      actorId: workspaceContext.currentUser.id,
      type: "workspace.invitation_revoked",
      resourceType: "workspace",
      resourceId: workspaceContext.currentWorkspace.id,
      title: "Workspace invitation revoked",
      body: `${workspaceContext.currentUser.displayName} revoked your invitation to ${workspaceContext.currentWorkspace.name}.`,
      actionHref: "/inbox",
      severity: "warning",
      dedupeKey: `workspace.invitation_revoked:${workspaceContext.currentWorkspace.id}:${normalizedInvitationId}:${invitedUser.id}`,
      metadata: {
        invitationId: normalizedInvitationId,
        workspaceName: workspaceContext.currentWorkspace.name,
        inviteeEmail: invitation.email,
      },
    });
  }
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function addWorkspaceMemberAction(input: {
  email: string;
  role: WorkspaceRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("workspace.members.missing_email");
  }
  if (input.role === "owner" && workspaceContext.currentMembership.role !== "owner") {
    throw new Error("workspace.members.owner_only");
  }

  const user = readUserByEmailSync(normalizedEmail);
  if (!user) {
    throw new Error("workspace.members.account_not_found");
  }

  const members = listWorkspaceMemberUsersSync(workspaceContext.currentWorkspace.id);
  if (members.some((member) => member.userId === user.id)) {
    throw new Error("workspace.members.already_member");
  }

  const membership = upsertWorkspaceMembershipSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    userId: user.id,
    role: input.role,
    invitedBy: workspaceContext.currentUser.id,
  });
  addHumanMemberSync({
    name: user.displayName,
    role: membership.role,
  }, workspaceContext.currentWorkspace.id);

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace member added",
    note: `${workspaceContext.currentUser.displayName} added ${user.displayName} as ${input.role}.`,
    code: "workspace.member_added",
    data: {
      actorType: "session_user",
      resourceType: "workspace_member",
      resourceId: membership.id,
      targetUserId: user.id,
      targetRole: input.role,
    },
  });
  createNotificationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    recipientType: "human",
    recipientId: user.id,
    actorType: "human",
    actorId: workspaceContext.currentUser.id,
    type: "workspace.member_added",
    resourceType: "workspace_member",
    resourceId: membership.id,
    title: "Added to workspace",
    body: `${workspaceContext.currentUser.displayName} added you to ${workspaceContext.currentWorkspace.name} as ${input.role}.`,
    actionHref: "/settings",
    severity: "success",
    dedupeKey: `workspace.member_added:${workspaceContext.currentWorkspace.id}:${user.id}`,
    metadata: {
      membershipId: membership.id,
      workspaceName: workspaceContext.currentWorkspace.name,
      targetRole: input.role,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function updateWorkspaceMemberRoleAction(input: {
  userId: string;
  role: WorkspaceRole;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  const members = listWorkspaceMemberUsersSync(workspaceContext.currentWorkspace.id);
  const target = findWorkspaceMemberOrThrow(members, input.userId);

  assertCanManageWorkspaceMember(workspaceContext, target, members, input.role, "update_role");
  if (target.role === input.role) {
    return;
  }

  updateWorkspaceMembershipRoleSync(workspaceContext.currentWorkspace.id, input.userId, input.role);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace member role updated",
    note: `${workspaceContext.currentUser.displayName} changed ${target.displayName} from ${target.role} to ${input.role}.`,
    code: "workspace.member_role_updated",
    data: {
      actorType: "session_user",
      resourceType: "workspace_member",
      resourceId: input.userId,
      previousRole: target.role,
      targetRole: input.role,
    },
  });
  createNotificationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    recipientType: "human",
    recipientId: target.userId,
    actorType: "human",
    actorId: workspaceContext.currentUser.id,
    type: "workspace.member_role_updated",
    resourceType: "workspace_member",
    resourceId: target.userId,
    title: "Workspace role updated",
    body: `${workspaceContext.currentUser.displayName} changed your role in ${workspaceContext.currentWorkspace.name} from ${target.role} to ${input.role}.`,
    actionHref: "/settings",
    severity: input.role === "owner" || input.role === "admin" ? "success" : "info",
    dedupeKey: `workspace.member_role_updated:${workspaceContext.currentWorkspace.id}:${target.userId}:${input.role}`,
    metadata: {
      workspaceName: workspaceContext.currentWorkspace.name,
      previousRole: target.role,
      targetRole: input.role,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function removeWorkspaceMemberAction(userId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  const members = listWorkspaceMemberUsersSync(workspaceContext.currentWorkspace.id);
  const target = findWorkspaceMemberOrThrow(members, userId);

  assertCanManageWorkspaceMember(workspaceContext, target, members, undefined, "remove");
  removeWorkspaceMembershipSync(workspaceContext.currentWorkspace.id, userId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace member removed",
    note: `${workspaceContext.currentUser.displayName} removed ${target.displayName} from the workspace.`,
    code: "workspace.member_removed",
    data: {
      actorType: "session_user",
      resourceType: "workspace_member",
      resourceId: userId,
      previousRole: target.role,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

export async function transferWorkspaceOwnershipAction(userId: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertLocalWorkspaceManagementAllowed(workspaceContext.currentWorkspace.id);
  assertWorkspaceRoleForContext(workspaceContext, "owner");

  const members = listWorkspaceMemberUsersSync(workspaceContext.currentWorkspace.id);
  const target = findWorkspaceMemberOrThrow(members, userId);
  if (target.userId === workspaceContext.currentUser.id) {
    throw new Error("workspace.members.cannot_manage_self");
  }
  if (target.role === "owner") {
    throw new Error("workspace.members.already_owner");
  }

  transferWorkspaceOwnershipSync(
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    target.userId,
  );
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace ownership transferred",
    note: `${workspaceContext.currentUser.displayName} transferred ownership to ${target.displayName}.`,
    code: "workspace.ownership_transferred",
    data: {
      actorType: "session_user",
      resourceType: "workspace_member",
      resourceId: target.userId,
      previousOwnerUserId: workspaceContext.currentUser.id,
      nextOwnerUserId: target.userId,
    },
  });
  createNotificationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    recipientType: "human",
    recipientId: target.userId,
    actorType: "human",
    actorId: workspaceContext.currentUser.id,
    type: "workspace.ownership_transferred.new_owner",
    resourceType: "workspace",
    resourceId: workspaceContext.currentWorkspace.id,
    title: "Workspace ownership transferred",
    body: `${workspaceContext.currentUser.displayName} transferred ownership of ${workspaceContext.currentWorkspace.name} to you.`,
    actionHref: "/settings",
    severity: "success",
    dedupeKey: `workspace.ownership_transferred.new_owner:${workspaceContext.currentWorkspace.id}:${target.userId}`,
    metadata: {
      workspaceName: workspaceContext.currentWorkspace.name,
      previousOwnerUserId: workspaceContext.currentUser.id,
      nextOwnerUserId: target.userId,
    },
  });
  createNotificationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    recipientType: "human",
    recipientId: workspaceContext.currentUser.id,
    actorType: "human",
    actorId: workspaceContext.currentUser.id,
    type: "workspace.ownership_transferred.previous_owner",
    resourceType: "workspace",
    resourceId: workspaceContext.currentWorkspace.id,
    title: "Workspace ownership transferred",
    body: `You transferred ownership of ${workspaceContext.currentWorkspace.name} to ${target.displayName}.`,
    actionHref: "/settings",
    severity: "info",
    dedupeKey: `workspace.ownership_transferred.previous_owner:${workspaceContext.currentWorkspace.id}:${workspaceContext.currentUser.id}:${target.userId}`,
    metadata: {
      workspaceName: workspaceContext.currentWorkspace.name,
      previousOwnerUserId: workspaceContext.currentUser.id,
      nextOwnerUserId: target.userId,
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
}

function findWorkspaceMemberOrThrow(
  members: WorkspaceMemberUserRecord[],
  userId: string,
): WorkspaceMemberUserRecord {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("workspace.members.missing_user");
  }

  const target = members.find((member) => member.userId === normalizedUserId);
  if (!target) {
    throw new Error("workspace.members.not_found");
  }

  return target;
}

function assertCanManageWorkspaceMember(
  workspaceContext: Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>,
  target: WorkspaceMemberUserRecord,
  members: WorkspaceMemberUserRecord[],
  nextRole: WorkspaceRole | undefined,
  operation: "update_role" | "remove",
): void {
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  if (target.userId === workspaceContext.currentUser.id) {
    throw new Error("workspace.members.cannot_manage_self");
  }

  if (workspaceContext.currentMembership.role === "admin") {
    if (target.role === "owner" || nextRole === "owner") {
      throw new Error("workspace.members.owner_only");
    }
    return;
  }

  const ownerCount = members.filter((member) => member.role === "owner").length;
  const demotingOwner = target.role === "owner" && nextRole && nextRole !== "owner";
  const removingOwner = target.role === "owner" && operation === "remove";
  if ((demotingOwner || removingOwner) && ownerCount <= 1) {
    throw new Error("workspace.members.last_owner");
  }
}
