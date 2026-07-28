import { readAuthIdentityForUserSync, readWorkspaceSsoBindingSync } from "@dofe-agent/db";
import { getSsoInternalClient } from "./sso-internal-client";

/**
 * Transfer workspace ownership at the IdP (sso.dofe.ai) so the change is durable
 * across SSO re-sync. Workspace roles are IdP-authored: every non-superadmin login
 * overwrites the local `workspace_membership` role from the IdP, so writing here is
 * the only way to make an ownership transfer persist.
 *
 * Order is deliberate: promote the target to OWNER first, then demote the current
 * owner to ADMIN. The scope briefly has two owners and is therefore never ownerless
 * mid-flight; the IdP last-owner guard (sso.dofe.ai) sees count=2 when demoting and
 * allows it, ending at one owner. A promote failure aborts (actor stays owner); a
 * demote failure leaves two owners (over-permissive, never ownerless, converges on retry).
 */
export async function transferSsoWorkspaceOwnership(input: {
  workspaceId: string;
  currentOwnerUserId: string;
  nextOwnerUserId: string;
  actorUserId?: string;
}): Promise<void> {
  const binding = readWorkspaceSsoBindingSync(input.workspaceId);
  if (!binding) throw new Error("workspace.sso_binding_missing");

  const actorSubject = resolveSsoSubject(input.currentOwnerUserId);
  const nextSubject = resolveSsoSubject(input.nextOwnerUserId);
  if (!actorSubject || !nextSubject) {
    throw new Error("workspace.members.sso_subject_missing");
  }

  const client = getSsoInternalClient();

  if (binding.source === "team") {
    if (!binding.teamId) throw new Error("workspace.sso_binding_missing");
    // Promote first so the team is never ownerless.
    await client.teams.updateMemberRole(binding.teamId, nextSubject, { role: "OWNER" });
    await client.teams.updateMemberRole(binding.teamId, actorSubject, { role: "ADMIN" });
    return;
  }

  // Tenant-scoped workspace: transfer tenant ownership.
  await client.tenants.updateMemberRole(binding.tenantId, nextSubject, { role: "OWNER" });
  await client.tenants.updateMemberRole(binding.tenantId, actorSubject, { role: "ADMIN" });
}

function resolveSsoSubject(localUserId: string): string | null {
  const identity = readAuthIdentityForUserSync(localUserId, "sso");
  return identity?.providerSubject ?? null;
}
