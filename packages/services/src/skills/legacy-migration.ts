import {
  auditLogExistsForCodeSync,
  backfillMissingAssignmentDigestsForSkillSync,
  getDatabase,
  listAllWorkspacesSync,
  listSkillArtifactBindingsForSkillSync,
  listStoredWorkspaceSkillsSync,
  readSkillArtifactByDigestSync,
  readStoredSkillActiveArtifactDigestSync,
  recordAuditLogSync,
  withTransaction,
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
  /**
   * Skills whose binding already existed from a prior (partial) run but whose
   * assignment mapping and/or migration audit were completed THIS run. This is
   * the self-heal path: a run that crashed after creating the binding but before
   * the downstream phases converges here instead of being silently skipped.
   */
  reconciled: number;
  /** Skills that were already fully migrated (idempotent re-runs). */
  alreadyMigrated: number;
  /** Skills that cannot be migrated automatically (e.g. missing SKILL.md). */
  failed: number;
  failures: LegacySkillMigrationFailure[];
  /**
   * Un-bound skills skipped THIS run because the Phase-A build budget (`limit`)
   * was spent. Already-bound skills are NEVER deferred — their reconciliation is
   * cheap and uncapped — so a non-zero count means fresh builds were postponed to
   * the next maintenance tick, not that partial migrations went unreconciled.
   */
  deferred: number;
}

const LEGACY_MIGRATION_AUDIT_CODE = "skill.legacy_migrated";

/**
 * Phase 6.1 legacy migration (06-实施计划 §9.1): builds a `legacy` provenance
 * artifact for every legacy skill that has none, binds it to the skill lineage
 * and maps existing employee assignments onto the artifact digest.
 *
 * Hard guarantees from the design:
 * - 不擅自赋可执行权 — no installation is created; a migrated skill still
 *   needs the normal prepare/verify flow before any task can run it, and
 *   artifacts flagged legacy_incomplete are rejected at plan creation.
 * - 原子且可自愈 — the gating predicate is NOT "a binding exists" (which Phase A
 *   satisfies first, masking a later failure). Assignment mapping (Phase B) and
 *   the migration audit (Phase C) run together inside one DB transaction, and a
 *   re-run reconciles any phase left incomplete by a crash: the binding's digest
 *   is reused, still-unmapped assignments are backfilled, and the audit is
 *   recorded exactly once per (skill, digest). A skill is reported `migrated`
 *   only when freshly built, `reconciled` when self-healed, `alreadyMigrated`
 *   only when nothing remained to do.
 * - Idempotent and bounded — `limit` caps the expensive Phase A (artifact build
 *   + blob upload) per run; reconciliation of already-bound skills is cheap and
 *   uncapped so a backlog of partial migrations clears quickly. The maintenance
 *   loop re-drives this stage safely.
 * - 老 Skill 不丢失 — a skill that cannot be migrated (missing SKILL.md) is
 *   reported in `failures` and left untouched, never deleted.
 */
export function migrateLegacySkillArtifactsSync(input: {
  workspaceId: string;
  limit?: number;
}): LegacySkillMigrationResult {
  const workspaceId = input.workspaceId;
  const limit = Math.max(1, Math.floor(input.limit ?? 100));
  const skills = [...listStoredWorkspaceSkillsSync(workspaceId)]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  const result: LegacySkillMigrationResult = {
    scanned: 0,
    migrated: 0,
    reconciled: 0,
    alreadyMigrated: 0,
    failed: 0,
    failures: [],
    deferred: 0,
  };

  for (const skill of skills) {
    result.scanned += 1;

    try {
      // Phase A — artifact + binding + active digest. Idempotent: an identical
      // re-import short-circuits inside buildAndPersistSkillArtifactSync. When a
      // LEGACY binding already exists from a prior (possibly partial) run we DO
      // NOT skip — we reuse its digest and reconcile the downstream phases below.
      const bindings = listSkillArtifactBindingsForSkillSync(skill.id, workspaceId);
      // Resolve provenance per binding. A `legacy`-sourceType artifact is THIS
      // migrator's handiwork; any other sourceType ("local"/"import"/...) is a
      // modern artifact owned by the normal build/import flow. Treating "has any
      // binding" as "legacy-migrated" used to pull modern multi-version skills
      // onto the reconciliation path, backfilling empty assignments onto the
      // OLDEST binding (bindings are created_at ASC) and emitting a spurious
      // skill.legacy_migrated audit for a skill that was never legacy storage.
      const legacyBindings = bindings.filter(
        (candidate) => readSkillArtifactByDigestSync(candidate, workspaceId)?.sourceType === "legacy",
      );
      let digest: string;
      let builtThisRun: boolean;
      let legacyIncomplete: boolean;
      if (legacyBindings.length > 0) {
        const active = readStoredSkillActiveArtifactDigestSync(skill.id, workspaceId);
        // Mixed-lineage guard: the skill keeps its legacy binding(s) but its
        // ACTIVE artifact is now a MODERN (non-legacy) one — the lineage has
        // moved on from legacy storage. Phase B below would otherwise backfill
        // any still-unmapped per-employee assignment onto the OLDEST legacy
        // binding (bindings are created_at ASC), pointing employees at a
        // superseded version the modern build/import flow is responsible for.
        // Leave such a skill entirely alone: its legacy binding is historical.
        if (active && !legacyBindings.includes(active)) {
          result.alreadyMigrated += 1;
          continue;
        }
        // Reconciliation path — cheap, and NEVER gated by `limit`. A backlog of
        // partial migrations (legacy binding present, downstream phases incomplete)
        // must clear every tick even after the Phase-A build budget is spent.
        // Prefer the skill's ACTIVE digest when it is one of the legacy artifacts
        // (the version installs/assignments resolve to) — never the oldest binding.
        digest = active ?? legacyBindings[0]!;
        builtThisRun = false;
        const existing = readSkillArtifactByDigestSync(digest, workspaceId);
        legacyIncomplete = existing?.legacyIncomplete ?? false;
      } else if (bindings.length === 0) {
        // No artifact at all — a file-only legacy skill. Build its legacy artifact
        // (Phase A). `limit` caps ONLY this expensive branch (build + blob upload);
        // once spent, defer to the next maintenance tick. Reconciliation above is
        // the uncapped path, so a backlog of PARTIAL migrations is never starved.
        if (result.migrated >= limit) {
          result.deferred += 1;
          continue;
        }
        const built = buildLegacyArtifactFromSkillSync({
          workspaceId,
          skillId: skill.id,
          name: skill.name,
          files: skill.files.map((file) => ({ path: file.path, content: file.content })),
          sourceUrl: skill.sourceUrl,
        });
        digest = built.digest;
        builtThisRun = true;
        legacyIncomplete = built.artifact.legacyIncomplete;
      } else {
        // The skill has ONLY modern (non-legacy) artifacts — it was created by
        // the normal build/import flow, not legacy file-only storage. Nothing for
        // the legacy migrator to do: no assignment backfill, no legacy audit.
        result.alreadyMigrated += 1;
        continue;
      }

      // Phases B + C run inside one transaction so a single maintenance tick can
      // never leave assignments mapped without an audit (or vice versa). Phase A
      // is excluded: it also writes content-addressed blobs to object storage,
      // which cannot enlist in the DB transaction. Both B and C are individually
      // idempotent, so a crash between A's commit and this commit self-heals on
      // the next run (the digest is reused from the surviving binding).
      let reconciledThisRun = false;
      withTransaction(getDatabase(), () => {
        // Phase B — map existing assignments onto the artifact digest. Backfills
        // ONLY unmapped (NULL) rows, never clobbering an assignment later
        // repointed by a re-import. Idempotent: a complete skill matches none.
        const mapped = backfillMissingAssignmentDigestsForSkillSync({
          workspaceId,
          skillId: skill.id,
          digest,
        });
        // Phase C — migration audit, recorded at most once per (skill, digest).
        // A repeat or self-healing run finds the prior row and skips, so the
        // audit trail shows a single migration event, not one per tick.
        const audited = auditLogExistsForCodeSync({
          workspaceId,
          code: LEGACY_MIGRATION_AUDIT_CODE,
          jsonData: { skillId: skill.id, digest },
        });
        if (!audited) {
          recordAuditLogSync({
            workspaceId,
            title: "Legacy skill migrated to artifact",
            note: `Legacy skill "${skill.name}" was reconstructed as artifact ${digest}${legacyIncomplete ? " (incomplete: re-import required before install)" : ""}.`,
            code: LEGACY_MIGRATION_AUDIT_CODE,
            source: "skill_lifecycle",
            data: {
              skillId: skill.id,
              digest,
              legacyIncomplete,
              fileCount: skill.files.length,
            },
          });
        }
        if (!builtThisRun && (mapped > 0 || !audited)) {
          reconciledThisRun = true;
        }
      });

      if (builtThisRun) {
        result.migrated += 1;
      } else if (reconciledThisRun) {
        result.reconciled += 1;
      } else {
        result.alreadyMigrated += 1;
      }
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
  reconciled: number;
  alreadyMigrated: number;
  failed: number;
  deferred: number;
} {
  const aggregate = { workspaces: 0, migrated: 0, reconciled: 0, alreadyMigrated: 0, failed: 0, deferred: 0 };
  for (const workspace of listAllWorkspacesSync()) {
    aggregate.workspaces += 1;
    try {
      const result = migrateLegacySkillArtifactsSync({
        workspaceId: workspace.id,
        limit: input.limitPerWorkspace,
      });
      aggregate.migrated += result.migrated;
      aggregate.reconciled += result.reconciled;
      aggregate.alreadyMigrated += result.alreadyMigrated;
      aggregate.failed += result.failed;
      aggregate.deferred += result.deferred;
    } catch {
      aggregate.failed += 1;
    }
  }
  return aggregate;
}
