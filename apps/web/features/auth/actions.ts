"use server";

import { redirect } from "next/navigation";
import { readWorkspaceSync } from "@agent-space/db";
import { tryRecordWorkspaceAuditEventSync } from "@agent-space/services";
import { clearCurrentSession, readCurrentSsoIdToken } from "./server-auth";
import { getSsoLogoutUrl } from "./sso-oidc";
import { requireCurrentWorkspaceContext } from "./server-workspace";
import { writeWorkspaceSelectionCookie } from "./workspace-selection";

export async function logoutAction(): Promise<{ ok: true }> {
  await clearCurrentSession();
  return { ok: true };
}

export async function logoutAndRedirectAction(): Promise<void> {
  const idToken = await readCurrentSsoIdToken();
  const logoutUrl = idToken ? await getSsoLogoutUrl(idToken) : "/";
  await clearCurrentSession();
  redirect(logoutUrl);
}

export async function switchWorkspaceAction(workspaceId: string): Promise<{ ok: true }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const workspace = readWorkspaceSync(workspaceId.trim());
  const hasMembership = workspaceContext.memberships.some((membership) => membership.workspaceId === workspace?.id);
  if (!workspace || !workspace.id.startsWith("sso-") || !hasMembership) throw new Error("Forbidden.");
  await writeWorkspaceSelectionCookie(workspace.slug);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspace.id,
    title: "Workspace switched",
    note: `${workspaceContext.currentUser.displayName} switched into workspace "${workspace.name}".`,
    code: "workspace.switched",
    data: { actorType: "session_user", resourceType: "workspace", resourceId: workspace.id },
  });
  return { ok: true };
}
