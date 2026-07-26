"use server";

import {
  readWorkspaceSync,
} from "@dofe-agent/db";
import {
  acceptChannelInvitationForActorSync,
  rejectChannelInvitationForActorSync,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { getCurrentUser } from "@/features/auth/server-auth";
import { writeWorkspaceSelectionCookie } from "@/features/auth/workspace-selection";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";

export async function acceptChannelInvitationAction(
  invitationId: string,
): Promise<{ workspaceSlug: string; channelName: string }> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("Unauthorized.");
  }

  const accepted = acceptChannelInvitationForActorSync({
    invitationId: invitationId.trim(),
    actor: {
      userId: currentUser.id,
      displayName: currentUser.displayName,
    },
  });
  const workspace = readWorkspaceSync(accepted.workspaceId);
  if (!workspace) {
    throw new Error("workspace.not_found");
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspace.id,
    title: "Channel invitation accepted",
    note: `${currentUser.displayName} accepted an invitation to join #${accepted.channelName}.`,
    code: "channel.invitation_accepted",
    data: {
      actorType: "session_user",
      resourceType: "channel_invitation",
      resourceId: accepted.id,
      channelName: accepted.channelName,
      targetUserId: currentUser.id,
    },
  });

  await writeWorkspaceSelectionCookie(workspace.slug);
  revalidateWorkspacePaths(workspace.slug, ["/im", "/contacts", "/settings/permissions"]);
  return {
    workspaceSlug: workspace.slug,
    channelName: accepted.channelName,
  };
}

export async function rejectChannelInvitationAction(invitationId: string): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("Unauthorized.");
  }

  const rejected = rejectChannelInvitationForActorSync({
    invitationId: invitationId.trim(),
    actor: {
      userId: currentUser.id,
      displayName: currentUser.displayName,
    },
  });
  const workspace = readWorkspaceSync(rejected.workspaceId);
  if (workspace) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspace.id,
      title: "Channel invitation rejected",
      note: `${currentUser.displayName} rejected an invitation to join #${rejected.channelName}.`,
      code: "channel.invitation_rejected",
      data: {
        actorType: "session_user",
        resourceType: "channel_invitation",
        resourceId: rejected.id,
        channelName: rejected.channelName,
        targetUserId: currentUser.id,
      },
    });
    revalidateWorkspacePaths(workspace.slug, ["/contacts", "/settings/permissions"]);
  }
}
