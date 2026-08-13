import {
  listAllWorkspacesSync,
  listSkillArtifactBindingsForSkillSync,
  listStoredWorkspaceSkillsSync,
  recordAuditLogSync,
  setAssignmentArtifactDigestsForSkillSync,
} from "@dofe-agent/db";
import { buildLegacyArtifactFromSkillSync } from "./skill-artifacts.ts";

export interface LegacySkillMigrationFailure {
  skillId: string;
  name: string;
  reason: string;
}

export interface LegacySkillMigrationResult {
  scanned: number;
  /** Skills that received a new artifact + binding + assignment mapping. */
  migrated: number;
  /** Skills that already had an artifact binding (idempotent re-runs). */
  alreadyMigrated: number;
  /** Skills that cannot be migrated automatically (e.g. missing SKILL.md). */
  failed: number;
  failures: LegacySkillMigrationFailure[];
}

/**
 * Phase 6.1 legacy migration (06-实施计划 §9.1): builds a `legacy` provenance
 * artifact for every legacy skill that has none, binds it to the skill lineage
 * and maps existing employee assignments onto the artifact digest.
 *
 * Hard guarantees from the design:
 * - 不擅自赋可执行权 — no installation is created; a migrated skill still
 *   needs the normal prepare/verify flow before any task can run it, and
 *   artifacts flagged legacy_incomplete are rejected at plan creation.
 * - Idempotent and bounded — skills with an existing binding are skipped, so
 *   the maintenance loop can re-drive this stage safely; `limit` caps one run.
 * - 老 Skill 不丢失 — a skill that cannot be migrated (missing SKILL.md) is
 *   reported in `failures` and left untouched, never deleted.
 */
export function migrateLegacySkillArtifactsSync(input: {
  workspaceId: string;
  limit?: number;
}): LegacySkillMigrationResult {
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const skills = [...listStoredWorkspaceSkillsSync(input.workspaceId)]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  const result: LegacySkillMigrationResult = {
    scanned: 0,
    migrated: 0,
    alreadyMigrated: 0,
    failed: 0,
    failures: [],
  };

  for (const skill of skills) {
    if (result.migrated >= limit) {
      break;
    }
    result.scanned += 1;
    if (listSkillArtifactBindingsForSkillSync(skill.id, input.workspaceId).length > 0) {
      result.alreadyMigrated += 1;
      continue;
    }
    try {
      const built = buildLegacyArtifactFromSkillSync({
        workspaceId: input.workspaceId,
        skillId: skill.id,
        name: skill.name,
        files: skill.files.map((file) => ({ path: file.path, content: file.content })),
        sourceUrl: skill.sourceUrl,
      });
      // 现有 assignment 映射到 artifact（不创建 installation）。
      setAssignmentArtifactDigestsForSkillSync({
        workspaceId: input.workspaceId,
        skillId: skill.id,
        digest: built.digest,
      });
      recordAuditLogSync({
        workspaceId: input.workspaceId,
        title: "Legacy skill migrated to artifact",
        note: `Legacy skill "${skill.name}" was reconstructed as artifact ${built.digest}${built.artifact.legacyIncomplete ? " (incomplete: re-import required before install)" : ""}.`,
        code: "skill.legacy_migrated",
        source: "skill_lifecycle",
        data: {
          skillId: skill.id,
          digest: built.digest,
          legacyIncomplete: built.artifact.legacyIncomplete,
          fileCount: skill.files.length,
        },
      });
      result.migrated += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        skillId: skill.id,
        name: skill.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * Maintenance-stage entry point: migrates legacy skills across EVERY workspace
 * (bounded per workspace per run). A workspace whose migration throws is
 * reported in the aggregate instead of aborting the remaining workspaces.
 */
export function migrateAllWorkspaceLegacySkillsSync(input: { limitPerWorkspace?: number } = {}): {
  workspaces: number;
  migrated: number;
  alreadyMigrated: number;
  failed: number;
} {
  const aggregate = { workspaces: 0, migrated: 0, alreadyMigrated: 0, failed: 0 };
  for (const workspace of listAllWorkspacesSync()) {
    aggregate.workspaces += 1;
    try {
      const result = migrateLegacySkillArtifactsSync({
        workspaceId: workspace.id,
        limit: input.limitPerWorkspace,
      });
      aggregate.migrated += result.migrated;
      aggregate.alreadyMigrated += result.alreadyMigrated;
      aggregate.failed += result.failed;
    } catch {
      aggregate.failed += 1;
    }
  }
  return aggregate;
}
