import {
  completeBackupRestoreDrillRunSync,
  createBackupRestoreDrillRunSync,
  listEmployeePersistentWorkspacesSync,
  listRecoveryOperationsSync,
  listSkillArtifactsSync,
  listStaleCommitJournalsSync,
  readAssignmentArtifactDigestSync,
  readHeadRevisionSync,
  readSkillArtifactByDigestSync,
  type BackupRestoreDrillRunRecord,
  type EmployeeWorkspaceRevisionRecord,
} from "@dofe-agent/db";
import { listEmployeeSkillIdsSync } from "./employees.ts";
import { verifySkillArtifactIntegritySync } from "../skills/skill-artifacts.ts";
import { computeRevisionManifestDigest, type WorkspaceRevisionManifest } from "./persistent-workspace.ts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type DataProtectionAlertSeverity = "info" | "warning" | "error";

export interface DataProtectionAlert {
  code: string;
  severity: DataProtectionAlertSeverity;
  message: string;
  employeeName?: string;
  metric?: string;
  value?: number;
}

export interface DataProtectionHealthResult {
  alerts: DataProtectionAlert[];
  metrics: {
    workspaceHeadAgeSeconds: number;
    skillArtifactVerificationFailures: number;
    runtimeBindingGenerationConflicts: number;
    taskCommitReconciliationBacklog: number;
    runtimeRecoveryDurationSeconds: number;
  };
  checkedAt: string;
}

export interface BackupRestoreDrillResult {
  ok: boolean;
  checkedAt: string;
  samples: Array<{
    employeeName: string;
    workspaceManifestMatch: boolean;
    skillDigestsMatch: boolean;
    detail: string;
  }>;
}

export interface DataProtectionHealthOptions {
  workspaceId?: string;
  now?: string;
  /** Head revision older than this many seconds triggers a workspace_head_age alert. */
  headAgePolicySeconds?: number;
  /** A recovery op longer than this (seconds) triggers a runtime_recovery_duration alert. */
  recoveryRtoSeconds?: number;
}

/* ------------------------------------------------------------------ */
/* Health evaluation (P4: data-protection status + alerting)           */
/* ------------------------------------------------------------------ */

export function evaluateDataProtectionHealthSync(
  options: DataProtectionHealthOptions = {},
): DataProtectionHealthResult {
  const workspaceId = options.workspaceId ?? "default";
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const headAgePolicySeconds = options.headAgePolicySeconds ?? 7 * 24 * 3600;
  const recoveryRtoSeconds = options.recoveryRtoSeconds ?? 3600;

  const alerts: DataProtectionAlert[] = [];
  const workspaces = listEmployeePersistentWorkspacesSync(workspaceId);

  let workspaceHeadAgeSeconds = 0;
  let skillArtifactVerificationFailures = 0;
  let runtimeBindingGenerationConflicts = 0;
  let taskCommitReconciliationBacklog = 0;
  let runtimeRecoveryDurationSeconds = 0;

  // workspace_head_age: most recent committed revision across the workspace.
  for (const workspace of workspaces) {
    const head = readHeadRevisionSync(workspace.employeeName, workspaceId);
    if (!head) {
      continue;
    }
    const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(head.createdAt)) / 1000));
    workspaceHeadAgeSeconds = Math.max(workspaceHeadAgeSeconds, ageSeconds);
    if (ageSeconds > headAgePolicySeconds) {
      alerts.push({
        code: "workspace_head_age",
        severity: "warning",
        employeeName: workspace.employeeName,
        metric: "workspace_head_age",
        value: ageSeconds,
        message: `Employee "${workspace.employeeName}" head revision is ${formatAge(ageSeconds)} old (policy ${formatAge(headAgePolicySeconds)}).`,
      });
    }
  }

  // skill_artifact_verification_failures: verify every recent artifact's blobs.
  for (const artifact of listSkillArtifactsSync({ workspaceId, limit: 50 })) {
    if (artifact.legacyIncomplete) {
      skillArtifactVerificationFailures += 1;
      alerts.push({
        code: "skill_artifact_incomplete",
        severity: "warning",
        metric: "skill_artifact_verification_failures",
        message: `Skill artifact "${artifact.name}" is marked legacy_incomplete; new bindings are blocked until re-imported.`,
      });
      continue;
    }
    const result = verifySkillArtifactIntegritySync(artifact);
    if (!result.ok) {
      skillArtifactVerificationFailures += 1;
      alerts.push({
        code: "skill_artifact_verification_failure",
        severity: "error",
        metric: "skill_artifact_verification_failures",
        message: `Skill artifact "${artifact.name}" integrity check failed: ` +
          `missing=${result.missing.join(",") || "none"}, mismatched=${result.mismatched.length}.`,
      });
    }
  }

  // runtime_binding_generation_conflicts: failed/needs_attention recovery ops.
  const recoveryOps = listRecoveryOperationsSync({ workspaceId, limit: 20 });
  for (const op of recoveryOps) {
    if (op.phase === "failed") {
      runtimeBindingGenerationConflicts += 1;
      alerts.push({
        code: "runtime_recovery_failed",
        severity: "error",
        employeeName: op.employeeName,
        metric: "runtime_binding_generation_conflicts",
        message: `Recovery for "${op.employeeName}" failed at phase "${op.phase}": ${op.errorMessage ?? "unknown error"}.`,
      });
      continue;
    }
    if (op.phase === "completed" || op.phase === "activate") {
      const durationSeconds = Math.round((Date.parse(op.updatedAt) - Date.parse(op.createdAt)) / 1000);
      runtimeRecoveryDurationSeconds = Math.max(runtimeRecoveryDurationSeconds, durationSeconds);
      if (durationSeconds > recoveryRtoSeconds) {
        alerts.push({
          code: "runtime_recovery_slow",
          severity: "warning",
          employeeName: op.employeeName,
          metric: "runtime_recovery_duration",
          value: durationSeconds,
          message: `Recovery for "${op.employeeName}" took ${durationSeconds}s (RTO ${recoveryRtoSeconds}s).`,
        });
      }
    }
  }

  // task_commit_reconciliation_backlog: tasks stuck in preparing_commit.
  taskCommitReconciliationBacklog = listStaleCommitJournalsSync({
    workspaceId,
    staleBeforeSeconds: options.headAgePolicySeconds !== undefined ? 300 : 300,
  }).length;
  if (taskCommitReconciliationBacklog > 0) {
    alerts.push({
      code: "task_commit_reconciliation_backlog",
      severity: "warning",
      metric: "task_commit_reconciliation_backlog",
      value: taskCommitReconciliationBacklog,
      message: `${taskCommitReconciliationBacklog} task(s) stuck in preparing_commit need reconciliation.`,
    });
  }

  return {
    alerts,
    metrics: {
      workspaceHeadAgeSeconds,
      skillArtifactVerificationFailures,
      runtimeBindingGenerationConflicts,
      taskCommitReconciliationBacklog,
      runtimeRecoveryDurationSeconds,
    },
    checkedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Backup/restore drill (D-10)                                         */
/* ------------------------------------------------------------------ */

/**
 * Samples employees and verifies their workspace head manifest digest and bound
 * skill artifact digests recompute identically from the control-plane record.
 * This proves backups/records are readable and consistent without requiring a
 * cross-region physical restore (which depends on managed-storage decisions,
 * see docs §7). Returns ok=false if any sample mismatches.
 */
export function runBackupRestoreDrillSync(options: {
  workspaceId?: string;
  employeeNames?: string[];
  sampleLimit?: number;
}): BackupRestoreDrillResult {
  const workspaceId = options.workspaceId ?? "default";
  const workspaces = listEmployeePersistentWorkspacesSync(workspaceId);
  const employees = options.employeeNames ?? workspaces.slice(0, options.sampleLimit ?? 3).map((w) => w.employeeName);

  if (employees.length === 0) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      samples: [],
    };
  }

  const samples: BackupRestoreDrillResult["samples"] = [];
  for (const employeeName of employees) {
    samples.push(sampleEmployeeDrill(employeeName, workspaceId));
  }

  return {
    ok: samples.every((sample) => sample.workspaceManifestMatch && sample.skillDigestsMatch),
    checkedAt: new Date().toISOString(),
    samples,
  };
}

/**
 * Persistent backup/restore drill (D-10). Wraps `runBackupRestoreDrillSync` and
 * writes a `backup_restore_drill_run` record so the result is auditable and can
 * be surfaced in the data-protection UI. Returns the persisted run record.
 */
export function runBackupRestoreDrillRunSync(options: {
  workspaceId?: string;
  employeeNames?: string[];
  sampleLimit?: number;
  trigger?: BackupRestoreDrillRunRecord["trigger"];
}): BackupRestoreDrillRunRecord {
  const workspaceId = options.workspaceId ?? "default";
  const run = createBackupRestoreDrillRunSync({
    workspaceId,
    trigger: options.trigger ?? "manual",
    drillType: "metadata",
  });

  try {
    const result = runBackupRestoreDrillSync({
      workspaceId,
      employeeNames: options.employeeNames,
      sampleLimit: options.sampleLimit,
    });
    const successCount = result.samples.filter((s) => s.workspaceManifestMatch && s.skillDigestsMatch).length;
    const failureCount = result.samples.length - successCount;
    return completeBackupRestoreDrillRunSync({
      id: run.id,
      workspaceId,
      status: result.ok ? "completed" : "failed",
      sampleCount: result.samples.length,
      successCount,
      failureCount,
      resultJson: JSON.stringify(result),
      errorMessage: result.ok ? undefined : `${failureCount}/${result.samples.length} sample(s) failed`,
    });
  } catch (error) {
    return completeBackupRestoreDrillRunSync({
      id: run.id,
      workspaceId,
      status: "failed",
      sampleCount: 0,
      successCount: 0,
      failureCount: 1,
      resultJson: "{}",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function sampleEmployeeDrill(employeeName: string, workspaceId: string): BackupRestoreDrillResult["samples"][number] {
  const details: string[] = [];
  let workspaceManifestMatch = true;
  let skillDigestsMatch = true;

  const head = readHeadRevisionSync(employeeName, workspaceId);
  if (!head) {
    return {
      employeeName,
      workspaceManifestMatch: false,
      skillDigestsMatch: true,
      detail: "No committed head revision to verify.",
    };
  }

  // Recompute the revision manifest digest from the stored manifest and compare.
  const recomputed = recomputeRevisionDigestFromManifest(head);
  if (recomputed !== head.manifestDigest) {
    workspaceManifestMatch = false;
    details.push(`revision digest mismatch (stored ${head.manifestDigest.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)`);
  } else {
    details.push(`revision ${head.id.slice(-6)} digest OK`);
  }

  // Verify each bound skill's artifact digest is present + integrity-checked.
  const skillIds = listEmployeeSkillIdsSync(employeeName, workspaceId);
  for (const skillId of skillIds) {
    const digest = readAssignmentArtifactDigestSync({ employeeName, skillId, workspaceId });
    if (!digest) {
      details.push(`skill ${skillId.slice(-6)} has no pinned digest`);
      continue;
    }
    const artifact = readSkillArtifactByDigestSync(digest, workspaceId);
    if (!artifact) {
      skillDigestsMatch = false;
      details.push(`skill ${skillId.slice(-6)} digest ${digest.slice(0, 12)}… missing artifact`);
      continue;
    }
    const integrity = verifySkillArtifactIntegritySync(artifact);
    if (!integrity.ok) {
      skillDigestsMatch = false;
      details.push(`skill ${skillId.slice(-6)} integrity failed`);
    } else {
      details.push(`skill ${skillId.slice(-6)} digest OK`);
    }
  }

  return {
    employeeName,
    workspaceManifestMatch,
    skillDigestsMatch,
    detail: details.join("; ") || "ok",
  };
}

function recomputeRevisionDigestFromManifest(revision: EmployeeWorkspaceRevisionRecord): string {
  // The revision's manifest_digest is the sha256 of its canonical manifest
  // (taskId + files sorted by path). Recomputed from manifest_json with the same
  // serializer used at commit time → D-10: digest recomputes identically.
  try {
    const manifest = JSON.parse(revision.manifestJson) as WorkspaceRevisionManifest;
    return computeRevisionManifestDigest(manifest);
  } catch {
    return "";
  }
}

function formatAge(seconds: number): string {
  if (seconds >= 3600) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}
