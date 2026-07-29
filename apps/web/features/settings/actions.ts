"use server";

import {
  createDaemonApiTokenSync,
  isPlatformAdminUserSync,
  listWorkspaceMemberUsersSync,
  readDaemonApiTokenSync,
  revokeDaemonApiTokenSync,
  revokeOtherSessionsForUserSync,
  revokeSessionByIdSync,
  transferWorkspaceOwnershipSync,
} from "@dofe-agent/db";
import { resolveAgentRuntimeMode, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { getCurrentSession } from "@/features/auth/server-auth";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { transferSsoWorkspaceOwnership } from "@/features/auth/sso-workspace-ownership";
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

function assertManualDaemonTokenManagementEnabled(): void {
  if (resolveAgentRuntimeMode() === "remote") {
    throw new Error("manual_runtime.remote_mode_required");
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
  assertManualDaemonTokenManagementEnabled();
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

export async function transferWorkspaceOwnershipAction(input: {
  targetUserId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "owner");

  const targetUserId = input.targetUserId.trim();
  const actorUserId = workspaceContext.currentUser.id;
  if (!targetUserId) {
    throw new Error("Missing target user.");
  }
  if (targetUserId === actorUserId) {
    throw new Error("Cannot transfer ownership to yourself.");
  }
  if (isPlatformAdminUserSync(targetUserId)) {
    throw new Error("workspace.members.transfer_target_is_platform_admin");
  }

  const members = listWorkspaceMemberUsersSync(workspaceContext.currentWorkspace.id);
  const target = members.find((member) => member.userId === targetUserId);
  if (!target) {
    throw new Error("workspace.members.transfer_target_missing");
  }

  // Write to the IdP first so the change survives SSO re-sync, then mirror locally
  // for immediate UI consistency. Promote-before-demote guarantees the workspace is
  // never ownerless mid-flight.
  await transferSsoWorkspaceOwnership({
    workspaceId: workspaceContext.currentWorkspace.id,
    currentOwnerUserId: actorUserId,
    nextOwnerUserId: targetUserId,
  });
  transferWorkspaceOwnershipSync(
    workspaceContext.currentWorkspace.id,
    actorUserId,
    targetUserId,
  );

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Ownership transferred",
    note: `${workspaceContext.currentUser.displayName} transferred workspace ownership to ${target.displayName}.`,
    code: "workspace.ownership_transferred",
    data: {
      actorType: "session_user",
      resourceType: "workspace_membership",
      actorUserId,
      targetUserId,
      previousOwnerRole: "owner",
      newOwnerRole: "admin",
    },
  });
  revalidateSettingsPaths(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("所有权已转移。", "Ownership transferred."));
}
