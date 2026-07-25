import {
  acceptWorkspaceInvitationSync,
  readActiveWorkspaceInvitationByTokenSync,
  readWorkspaceInvitationByTokenSync,
  readWorkspaceSync,
  type WorkspaceInvitationStatus,
  type WorkspaceRole,
} from "@dofe-agent/db";
import { addHumanMemberSync, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { writeWorkspaceSelectionCookie } from "./workspace-selection";

export interface WorkspaceInvitationDetails {
  token: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
  acceptedAt?: string;
}

export function readWorkspaceInvitationDetailsSync(
  token: string,
  options?: { includeInactive?: boolean },
): WorkspaceInvitationDetails | null {
  const invitation = options?.includeInactive
    ? readWorkspaceInvitationByTokenSync(token)
    : readActiveWorkspaceInvitationByTokenSync(token);
  if (!invitation) {
    return null;
  }

  const workspace = readWorkspaceSync(invitation.workspaceId);
  if (!workspace) {
    return null;
  }

  return {
    token,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
  };
}

export async function acceptWorkspaceInvitationForUser(input: {
  token: string;
  userId: string;
  actorDisplayName: string;
}): Promise<WorkspaceInvitationDetails> {
  const invitation = acceptWorkspaceInvitationSync(input.token, input.userId);
  const workspace = readWorkspaceSync(invitation.workspaceId);
  if (!workspace) {
    throw new Error("workspace.invitation.workspace_not_found");
  }

  addHumanMemberSync({
    name: input.actorDisplayName,
    role: invitation.role,
  }, workspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspace.id,
    title: "Workspace invitation accepted",
    note: `${input.actorDisplayName} accepted an invitation to join the workspace.`,
    code: "workspace.invitation_accepted",
    data: {
      actorType: "session_user",
      resourceType: "workspace_invitation",
      resourceId: invitation.id,
      targetUserId: input.userId,
      targetRole: invitation.role,
    },
  });
  await writeWorkspaceSelectionCookie(workspace.slug);

  return {
    token: input.token,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
  };
}
