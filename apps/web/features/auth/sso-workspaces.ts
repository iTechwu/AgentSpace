import { createHash } from "node:crypto";
import {
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  listUserWorkspacesSync,
  readWorkspaceSync,
  removeWorkspaceMembershipSync,
  updateWorkspaceMembershipRoleSync,
  updateWorkspaceSync,
  type WorkspaceRole,
} from "@agent-space/db";
import { createDefaultWorkspaceState } from "@agent-space/domain/workspace";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "@agent-space/services";
import type { UserTeam, UserTenant } from "@dofe/sso-node";

export interface SsoWorkspaceScope {
  id: string;
  name: string;
  role: WorkspaceRole;
  tenantId: string;
  tenantName: string;
  teamId?: string;
  teamName?: string;
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
      teamId: team.teamId,
      teamName: team.teamName,
    })),
    ...input.tenants
      .filter((tenant) => !teamTenantIds.has(tenant.tenantId))
      .map((tenant) => ({
        id: ssoWorkspaceId("tenant", tenant.tenantId),
        name: tenant.tenantDisplayName?.trim() || tenant.tenantName,
        role: toWorkspaceRole(tenant.role),
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantDisplayName?.trim() || tenant.tenantName,
      })),
  ];

  return scopes.sort((left, right) => {
    const leftPreferred = left.tenantId === input.preferredTenantId ? 0 : 1;
    const rightPreferred = right.tenantId === input.preferredTenantId ? 0 : 1;
    return leftPreferred - rightPreferred || left.name.localeCompare(right.name);
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
    } else if (existingWorkspace.name !== scope.name) {
      updateWorkspaceSync(scope.id, { name: scope.name });
      const state = readWorkspaceStateSync(scope.id);
      writeWorkspaceStateSync({ ...state, organizationName: scope.name }, scope.id);
    }

    const membership = listUserWorkspacesSync(input.userId).find((item) => item.workspaceId === scope.id);
    if (membership) {
      updateWorkspaceMembershipRoleSync(scope.id, input.userId, scope.role);
    } else {
      createWorkspaceMembershipSync({ workspaceId: scope.id, userId: input.userId, role: scope.role });
    }
  }

  return [...input.scopes];
}

function ssoWorkspaceId(kind: "team" | "tenant", sourceId: string): string {
  return `sso-${kind}-${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}

function ssoWorkspaceSlug(scope: SsoWorkspaceScope): string {
  const source = `${scope.tenantName}-${scope.teamName ?? "tenant"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "sso-workspace";
  return `${source}-${scope.id.slice(-6)}`;
}

function toWorkspaceRole(role: string): WorkspaceRole {
  if (role === "OWNER") return "owner";
  if (role === "ADMIN") return "admin";
  return "member";
}

function workspaceRoleLabel(role: WorkspaceRole): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}
