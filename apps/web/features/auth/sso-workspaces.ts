import { createHash } from "node:crypto";
import {
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  listUserWorkspacesSync,
  readWorkspaceSync,
  removeWorkspaceMembershipSync,
  updateWorkspaceMembershipRoleSync,
  updateWorkspaceSync,
  upsertWorkspaceSsoBindingSync,
  type WorkspaceRole,
} from "@dofe-agent/db";
import { createDefaultWorkspaceState } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "@dofe-agent/services";
import type {
  InternalTeam,
  InternalTenant,
  SsoInternalClient,
  UserTeam,
  UserTenant,
} from "@dofe/sso-node";

export interface SsoWorkspaceScope {
  id: string;
  name: string;
  role: WorkspaceRole;
  tenantId: string;
  tenantName: string;
  tenantSlug?: string;
  teamId?: string;
  teamName?: string;
  teamSlug?: string;
}

export function buildSsoWorkspaceScopes(input: {
  teams: readonly UserTeam[];
  tenants: readonly UserTenant[];
  preferredTenantId?: string | null;
}): SsoWorkspaceScope[] {
  const teamTenantIds = new Set(input.teams.map((team) => team.tenantId));
  const scopes = [
    ...input.teams.map((team) => ({
      id: ssoWorkspaceId("team", team.teamId),
      name: `${team.tenantName} / ${team.teamName}`,
      role: toWorkspaceRole(team.role),
      tenantId: team.tenantId,
      tenantName: team.tenantName,
      tenantSlug: team.tenantSlug,
      teamId: team.teamId,
      teamName: team.teamName,
      teamSlug: team.teamSlug,
    })),
    ...input.tenants
      .filter((tenant) => !teamTenantIds.has(tenant.tenantId))
      .map((tenant) => ({
        id: ssoWorkspaceId("tenant", tenant.tenantId),
        name: tenant.tenantDisplayName?.trim() || tenant.tenantName,
        role: toWorkspaceRole(tenant.role),
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantDisplayName?.trim() || tenant.tenantName,
        tenantSlug: tenant.tenantSlug,
      })),
  ];

  return scopes.sort((left, right) => {
    const leftPreferred = left.tenantId === input.preferredTenantId ? 0 : 1;
    const rightPreferred = right.tenantId === input.preferredTenantId ? 0 : 1;
    return leftPreferred - rightPreferred || left.name.localeCompare(right.name);
  });
}

export async function buildSsoWorkspaceScopesForUser(input: {
  client: Pick<SsoInternalClient, "teams" | "tenants">;
  isAdmin: boolean;
  preferredTenantId?: string | null;
  teams: readonly UserTeam[];
  tenants: readonly UserTenant[];
}): Promise<SsoWorkspaceScope[]> {
  if (!input.isAdmin) {
    return buildSsoWorkspaceScopes(input);
  }

  const [teams, tenants] = await Promise.all([
    listAllSsoDirectoryItems((query) => input.client.teams.list(query)),
    listAllSsoDirectoryItems((query) => input.client.tenants.list(query)),
  ]);
  return buildSsoAdminWorkspaceScopes({
    preferredTenantId: input.preferredTenantId,
    teams,
    tenants,
  });
}

export function buildSsoAdminWorkspaceScopes(input: {
  teams: readonly InternalTeam[];
  tenants: readonly InternalTenant[];
  preferredTenantId?: string | null;
}): SsoWorkspaceScope[] {
  const tenantById = new Map(input.tenants.map((tenant) => [tenant.id, tenant]));
  const teams = input.teams
    .map((team): UserTeam | null => {
      const tenant = tenantById.get(team.tenantId);
      if (!tenant) {
        return null;
      }
      return {
        teamId: team.id,
        teamSlug: team.slug,
        teamName: team.name,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        role: "ADMIN",
      };
    })
    .filter((team): team is UserTeam => team !== null);
  const tenants = input.tenants.map((tenant): UserTenant => ({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    tenantDisplayName: tenant.name,
    role: "ADMIN",
  }));

  return buildSsoWorkspaceScopes({
    teams,
    tenants,
    preferredTenantId: input.preferredTenantId,
  });
}

export function syncSsoWorkspacesForUserSync(input: {
  displayName: string;
  scopes: readonly SsoWorkspaceScope[];
  userId: string;
}): SsoWorkspaceScope[] {
  const activeScopeIds = new Set(input.scopes.map((scope) => scope.id));
  for (const membership of listUserWorkspacesSync(input.userId)) {
    if (membership.workspaceId.startsWith("sso-") && !activeScopeIds.has(membership.workspaceId)) {
      removeWorkspaceMembershipSync(membership.workspaceId, input.userId);
    }
  }

  for (const scope of input.scopes) {
    const existingWorkspace = readWorkspaceSync(scope.id);
    if (!existingWorkspace) {
      createWorkspaceSync({
        id: scope.id,
        slug: ssoWorkspaceSlug(scope),
        name: scope.name,
        createdBy: input.userId,
      });
      const state = createDefaultWorkspaceState();
      state.organizationName = scope.name;
      state.humanMembers = [{ name: input.displayName, role: workspaceRoleLabel(scope.role) }];
      state.channels = [];
      writeWorkspaceStateSync(state, scope.id);
    } else {
      const nextSlug = ssoWorkspaceSlug(scope);
      if (existingWorkspace.name !== scope.name || existingWorkspace.slug !== nextSlug) {
        updateWorkspaceSync(scope.id, {
          ...(existingWorkspace.name !== scope.name ? { name: scope.name } : {}),
          ...(existingWorkspace.slug !== nextSlug ? { slug: nextSlug } : {}),
        });
      }
      if (existingWorkspace.name !== scope.name) {
        const state = readWorkspaceStateSync(scope.id);
        writeWorkspaceStateSync({ ...state, organizationName: scope.name }, scope.id);
      }
    }

    const membership = listUserWorkspacesSync(input.userId).find((item) => item.workspaceId === scope.id);
    if (membership) {
      updateWorkspaceMembershipRoleSync(scope.id, input.userId, scope.role);
    } else {
      createWorkspaceMembershipSync({ workspaceId: scope.id, userId: input.userId, role: scope.role });
    }

    // Persist the SSO tenant/team scope so managed-runtime provisioning can
    // resolve the models.dofe.ai tenantId/teamId without re-hitting the IdP.
    upsertWorkspaceSsoBindingSync({
      workspaceId: scope.id,
      tenantId: scope.tenantId,
      tenantSlug: scope.tenantSlug,
      tenantName: scope.tenantName,
      teamId: scope.teamId,
      teamSlug: scope.teamSlug,
      teamName: scope.teamName,
      source: scope.teamId ? "team" : "tenant",
    });
  }

  return [...input.scopes];
}

function ssoWorkspaceId(kind: "team" | "tenant", sourceId: string): string {
  return `sso-${kind}-${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}

function ssoWorkspaceSlug(scope: SsoWorkspaceScope): string {
  const source = [
    scope.tenantSlug,
    scope.teamSlug,
    scope.tenantName,
    scope.teamName,
  ]
    .map(toUrlSlugPart)
    .filter(Boolean)
    .join("-")
    .slice(0, 40) || "workspace";
  return `${source}-${scope.id.slice(-6)}`;
}

function toUrlSlugPart(value: string | undefined): string {
  const source = (value ?? "")
    .trim()
    .toLowerCase();
  const asciiSlug = source
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (asciiSlug) {
    return asciiSlug;
  }

  return source
    .replace(/[\\/?#%]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toWorkspaceRole(role: string): WorkspaceRole {
  if (role === "OWNER") return "owner";
  if (role === "ADMIN") return "admin";
  return "member";
}

function workspaceRoleLabel(role: WorkspaceRole): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

async function listAllSsoDirectoryItems<TItem>(
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
    if (result.list.length === 0 || items.length >= result.total) {
      return items;
    }
  }
}
