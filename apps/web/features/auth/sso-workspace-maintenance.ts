import { createHash } from "node:crypto";
import {
  archiveWorkspaceSync,
  getDatabase,
  listWorkspaceSsoBindingsSync,
  listWorkspacesSync,
  readWorkspaceSync,
  restoreWorkspaceSync,
  withTransaction,
  type StoredWorkspaceRecord,
  type WorkspaceSsoBindingRecord,
} from "@dofe-agent/db";

export interface SsoWorkspaceMaintenancePlan {
  activeWorkspaceIds: string[];
  archiveStaleBindingIds: string[];
  archiveTestWorkspaceIds: string[];
  restoreWorkspaceIds: string[];
}

export interface SsoWorkspaceMaintenanceResult {
  archivedIds: string[];
  restoredIds: string[];
}

export function createSsoWorkspaceScopeDigest(
  activeWorkspaceIds: ReadonlySet<string>,
): string {
  return createHash("sha256")
    .update(sorted(activeWorkspaceIds).join("\n"))
    .digest("hex");
}

export function assertSsoWorkspaceScopeConfirmation(
  activeWorkspaceIds: ReadonlySet<string>,
  confirmation: string | undefined,
): void {
  const expectedDigest = createSsoWorkspaceScopeDigest(activeWorkspaceIds);
  if (confirmation?.trim() !== expectedDigest) {
    throw new Error(
      `SSO workspace apply requires --confirm-scope-digest=${expectedDigest} from a fresh dry-run.`,
    );
  }
}

export function isDisposableTestWorkspace(
  workspace: StoredWorkspaceRecord,
  hasBinding: boolean,
): boolean {
  if (hasBinding) return false;

  const isE2e = /^sso-team-e2e-[a-z0-9]+-[a-z0-9]+$/.test(workspace.id)
    && /^E2E Workspace [a-z0-9]+-[a-z0-9]+$/.test(workspace.name);
  const isVisual = workspace.id.startsWith("sso-")
    && workspace.name === "Loading Visual Check";
  return isE2e || isVisual;
}

export function assertUniqueWorkspaceSsoBindings(
  bindings: readonly WorkspaceSsoBindingRecord[],
): void {
  assertUniqueScope(bindings, "team", (binding) => binding.teamId);
  assertUniqueScope(
    bindings.filter((binding) => binding.source === "tenant"),
    "tenant",
    (binding) => binding.tenantId,
  );
}

export function planSsoWorkspaceMaintenanceSync(
  activeWorkspaceIds: ReadonlySet<string>,
): SsoWorkspaceMaintenancePlan {
  const bindings = listWorkspaceSsoBindingsSync();
  assertUniqueWorkspaceSsoBindings(bindings);

  const bindingWorkspaceIds = new Set(bindings.map((binding) => binding.workspaceId));
  const archiveStaleBindingIds: string[] = [];
  const restoreWorkspaceIds: string[] = [];

  for (const binding of bindings) {
    const workspace = readWorkspaceSync(binding.workspaceId);
    if (!workspace) continue;
    if (activeWorkspaceIds.has(binding.workspaceId)) {
      if (workspace.archivedAt) restoreWorkspaceIds.push(binding.workspaceId);
    } else if (!workspace.archivedAt) {
      archiveStaleBindingIds.push(binding.workspaceId);
    }
  }

  const archiveTestWorkspaceIds = listWorkspacesSync()
    .filter((workspace) => (
      !activeWorkspaceIds.has(workspace.id)
      && isDisposableTestWorkspace(workspace, bindingWorkspaceIds.has(workspace.id))
    ))
    .map((workspace) => workspace.id);

  return {
    activeWorkspaceIds: sorted(activeWorkspaceIds),
    archiveStaleBindingIds: sorted(archiveStaleBindingIds),
    archiveTestWorkspaceIds: sorted(archiveTestWorkspaceIds),
    restoreWorkspaceIds: sorted(restoreWorkspaceIds),
  };
}

export function applySsoWorkspaceMaintenanceSync(
  plan: SsoWorkspaceMaintenancePlan,
): SsoWorkspaceMaintenanceResult {
  return withTransaction(getDatabase(), () => {
    const archivedIds: string[] = [];
    const restoredIds: string[] = [];

    for (const workspaceId of sorted(new Set([
      ...plan.archiveStaleBindingIds,
      ...plan.archiveTestWorkspaceIds,
    ]))) {
      const workspace = readWorkspaceSync(workspaceId);
      if (workspace && !workspace.archivedAt) {
        archiveWorkspaceSync(workspaceId);
        archivedIds.push(workspaceId);
      }
    }

    for (const workspaceId of sorted(plan.restoreWorkspaceIds)) {
      const workspace = readWorkspaceSync(workspaceId);
      if (workspace?.archivedAt) {
        restoreWorkspaceSync(workspaceId);
        restoredIds.push(workspaceId);
      }
    }

    return { archivedIds, restoredIds };
  });
}

function assertUniqueScope(
  bindings: readonly WorkspaceSsoBindingRecord[],
  scopeName: "team" | "tenant",
  readScopeId: (binding: WorkspaceSsoBindingRecord) => string | undefined,
): void {
  const workspaceIdsByScope = new Map<string, string[]>();
  for (const binding of bindings) {
    const scopeId = readScopeId(binding);
    if (!scopeId) continue;
    const workspaceIds = workspaceIdsByScope.get(scopeId) ?? [];
    workspaceIds.push(binding.workspaceId);
    workspaceIdsByScope.set(scopeId, workspaceIds);
  }

  for (const [scopeId, workspaceIds] of workspaceIdsByScope) {
    if (workspaceIds.length > 1) {
      throw new Error(
        `Duplicate SSO ${scopeName} binding "${scopeId}" for workspaces: ${sorted(workspaceIds).join(", ")}`,
      );
    }
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
