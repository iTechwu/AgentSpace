import { createSsoInternalClient } from "@dofe/sso-node";
import type { WorkspaceRole } from "@dofe-agent/db";
import { readServerEnvValue } from "./server-env";
import { buildSsoWorkspaceScopesForUser } from "./sso-workspaces";

export interface SsoWorkspaceDirectory {
  role: WorkspaceRole;
  workspaceName: string;
}

export async function loadSsoWorkspaceDirectory(input: {
  subject: string;
  workspaceId: string;
}): Promise<SsoWorkspaceDirectory> {
  const client = createSsoInternalClient({
    baseUrl: readRequiredSsoEnv("SSO_INTERNAL_API_URL"),
    internalSecret: readRequiredSsoEnv("INTERNAL_API_SECRET"),
    serviceName: readRequiredSsoEnv("SSO_SERVICE_NAME"),
  });
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

function readRequiredSsoEnv(name: string): string {
  const value = readServerEnvValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
