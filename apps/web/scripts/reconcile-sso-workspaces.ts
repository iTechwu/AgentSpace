import { getSsoInternalClient } from "../features/auth/sso-internal-client.ts";
import {
  applySsoWorkspaceMaintenanceSync,
  planSsoWorkspaceMaintenanceSync,
} from "../features/auth/sso-workspace-maintenance.ts";
import { buildSsoAdminWorkspaceScopes } from "../features/auth/sso-workspaces.ts";

const apply = process.argv.includes("--apply");
const client = getSsoInternalClient();
const [teams, tenants] = await Promise.all([
  listAllDirectoryItems((query) => client.teams.list(query)),
  listAllDirectoryItems((query) => client.tenants.list(query)),
]);
const scopes = buildSsoAdminWorkspaceScopes({ teams, tenants });
const plan = planSsoWorkspaceMaintenanceSync(
  new Set(scopes.map((scope) => scope.id)),
);
const result = apply ? applySsoWorkspaceMaintenanceSync(plan) : undefined;

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  authoritativeScopeCount: scopes.length,
  plan,
  result,
}, null, 2));

async function listAllDirectoryItems<TItem>(
  loadPage: (query: { limit: number; page: number; status: string }) => Promise<{
    list: TItem[];
    total: number;
  }>,
): Promise<TItem[]> {
  const limit = 100;
  const items: TItem[] = [];
  for (let page = 1; ; page += 1) {
    const result = await loadPage({ limit, page, status: "ACTIVE" });
    items.push(...result.list);
    if (result.list.length === 0 || items.length >= result.total) return items;
  }
}
