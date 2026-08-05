import { createSsoInternalClient } from "@dofe/sso-node";
import {
  applySsoWorkspaceMaintenanceSync,
  assertSsoWorkspaceScopeConfirmation,
  createSsoWorkspaceScopeDigest,
  planSsoWorkspaceMaintenanceSync,
} from "../features/auth/sso-workspace-maintenance.ts";
import {
  buildSsoAdminWorkspaceScopes,
  listAllSsoDirectoryItems,
} from "../features/auth/sso-workspaces.ts";

const apply = process.argv.includes("--apply");
const client = createSsoInternalClient({
  baseUrl: readRequiredEnv("SSO_INTERNAL_API_URL"),
  internalSecret: readRequiredEnv("INTERNAL_API_SECRET"),
  serviceName: readRequiredEnv("SSO_SERVICE_NAME"),
});
const [teams, tenants] = await Promise.all([
  listAllSsoDirectoryItems((query) => client.teams.list(query)),
  listAllSsoDirectoryItems((query) => client.tenants.list(query)),
]);
const scopes = buildSsoAdminWorkspaceScopes({ teams, tenants });
const activeWorkspaceIds = new Set(scopes.map((scope) => scope.id));
const authoritativeScopeDigest = createSsoWorkspaceScopeDigest(activeWorkspaceIds);
if (apply) {
  assertSsoWorkspaceScopeConfirmation(
    activeWorkspaceIds,
    readArgument("--confirm-scope-digest="),
  );
}
const plan = planSsoWorkspaceMaintenanceSync(activeWorkspaceIds);
const result = apply ? applySsoWorkspaceMaintenanceSync(plan) : undefined;

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  authoritativeScopeCount: scopes.length,
  authoritativeScopeDigest,
  plan,
  result,
}, null, 2));

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readArgument(prefix: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
