import type { WorkspaceRole } from "@dofe-agent/db";
import { getSsoInternalClient } from "./sso-internal-client";
import { buildSsoWorkspaceScopesForUser } from "./sso-workspaces";

export interface SsoWorkspaceDirectory {
  role: WorkspaceRole;
  workspaceName: string;
}

export async function loadSsoWorkspaceDirectory(input: {
  subject: string;
  workspaceId: string;
}): Promise<SsoWorkspaceDirectory> {
  const client = getSsoInternalClient();
  const [user, teams, tenants, preference] = await Promise.all([
    client.users.get(input.subject),
    client.users.getTeams(input.subject),
    client.users.getTenants(input.subject),
    client.users.getTenantPreference(input.subject),
  ]).catch(() => {
    throw new Error("auth.sso_user_lookup_failed");
  });
  const scope = (await buildSsoWorkspaceScopesForUser({
    client,
    isAdmin: user.isAdmin,
    teams,
    tenants,
    preferredTenantId: preference.lastTenantId,
  })).find((candidate) => candidate.id === input.workspaceId);
  if (!scope) {
    throw new Error("auth.sso_no_workspace");
  }

  return {
    role: scope.role,
    workspaceName: scope.name,
  };
}
