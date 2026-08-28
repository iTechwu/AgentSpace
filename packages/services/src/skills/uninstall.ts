import {
  getDatabase,
  listSkillInstallationsSync,
  listSkillServiceBindingsSync,
  readSkillInstallationSync,
  withTransaction,
} from "@dofe-agent/db";

/**
 * Uninstalls ONE skill installation. Deleting the installation cascades its
 * `skill_service_binding` rows (FK ON DELETE CASCADE), which is what makes a
 * managed service become "unreferenced" — the next retire sweep pass then
 * queues a retire operation for it. Returns how many service bindings were
 * removed so callers can audit the lifecycle effect.
 */
export function uninstallSkillInstallationSync(input: {
  workspaceId?: string;
  installationId: string;
}): { ok: true; removedBindings: number } | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const installation = readSkillInstallationSync(input.installationId, workspaceId);
  if (!installation) {
    return { ok: false, code: "installation_not_found", reason: `Skill installation "${input.installationId}" does not exist.` };
  }
  const removedBindings = listSkillServiceBindingsSync(input.installationId).length;
  const removed = getDatabase().prepare(
    `DELETE FROM skill_installation WHERE id = ? AND workspace_id = ?`,
  ).run(input.installationId, workspaceId).changes > 0;
  if (!removed) {
    return { ok: false, code: "installation_not_found", reason: "Skill installation disappeared during uninstall." };
  }
  return { ok: true, removedBindings };
}

/**
 * Uninstalls a skill from a runtime: removes EVERY revision installation for
 * (workspace, runtime, artifactDigest), atomically. The task readiness gate then
 * resolves to blocked for that skill on that runtime, and the retire sweep
 * reclaims any services that were only referenced by the removed installations.
 */
export function uninstallSkillFromRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
}): { ok: true; removedInstallations: number; removedBindings: number } | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const installations = listSkillInstallationsSync({
    workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
  });
  if (installations.length === 0) {
    return {
      ok: false,
      code: "no_installation",
      reason: "No skill installation exists for this runtime + artifact digest.",
    };
  }

  let removedInstallations = 0;
  let removedBindings = 0;
  withTransaction(getDatabase(), () => {
    for (const installation of installations) {
      const result = uninstallSkillInstallationSync({ workspaceId, installationId: installation.id });
      if (result.ok) {
        removedInstallations += 1;
        removedBindings += result.removedBindings;
      }
    }
  });
  return { ok: true, removedInstallations, removedBindings };
}
