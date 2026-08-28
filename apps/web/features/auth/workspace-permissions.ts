import type { WorkspaceRole } from "@dofe-agent/db";
import type { CurrentWorkspaceContext } from "./server-workspace-resolver";

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export function hasWorkspaceRole(role: WorkspaceRole, minimumRole: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimumRole];
}

export function assertWorkspaceRole(
  role: WorkspaceRole,
  minimumRole: WorkspaceRole,
  message = "Forbidden.",
): void {
  if (!hasWorkspaceRole(role, minimumRole)) {
    throw new Error(message);
  }
}

export function assertWorkspaceRoleForContext(
  context: CurrentWorkspaceContext,
  minimumRole: WorkspaceRole,
  message = "Forbidden.",
): void {
  assertWorkspaceRole(context.currentMembership.role, minimumRole, message);
}
