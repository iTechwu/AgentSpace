import {
  readAuthIdentityByProviderSubjectSync,
  readWorkspaceMembershipSync,
  readWorkspaceSync,
  type WorkspaceRole,
} from "@dofe-agent/db";
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
  if (process.env.DOFE_AGENT_E2E === "1") {
    return loadE2eWorkspaceDirectory(input);
  }
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

function loadE2eWorkspaceDirectory(input: {
  subject: string;
  workspaceId: string;
}): SsoWorkspaceDirectory {
  const identity = readAuthIdentityByProviderSubjectSync("sso", input.subject);
  const membership = identity
    ? readWorkspaceMembershipSync(input.workspaceId, identity.userId)
    : null;
  const workspace = membership ? readWorkspaceSync(input.workspaceId) : null;
  if (!membership || !workspace) {
    throw new Error("auth.sso_no_workspace");
  }
  return {
    role: membership.role,
    workspaceName: workspace.name,
  };
}
