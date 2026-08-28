import {
  completeRuntimeMaintenanceRunSync,
  createRuntimeMaintenanceRunSync,
  heartbeatRuntimeMaintenanceRunSync,
} from "@dofe-agent/db";
import {
  resumeManagedRuntimeCleanupRequestsAsync,
  resumePendingProvisioningTasksAsync,
} from "../runtime-provisioning/runtime-provisioning.ts";
import { drainTokenUsageRetriesSync } from "../models/usage-retry.ts";
import { reconcileAllManagedRuntimeUsageAsync } from "../models/usage-sync.ts";
import { scheduleMcpHealthChecksSync } from "../mcp-center/connections.ts";
import { advanceRecoverableOperationsSync } from "../employees/recovery-worker.ts";
import { runEmployeeLifecycleMaintenanceSync } from "../employees/lifecycle-maintenance.ts";
import { sendExternalPagerAlert } from "../observability/external-pager.ts";
import { retireUnreferencedManagedSkillServicesSync } from "../skill-services/bindings.ts";
import { migrateAllWorkspaceLegacySkillsSync } from "../skills/legacy-migration.ts";
import {
  requeueExpiredManagedSkillServiceOperationLeasesSync,
  requeueExpiredSkillInstallationOperationLeasesSync,
  flushPrismaCutoverSloSnapshotsSync,
  type PrismaCutoverSloThresholds,
  archivePrismaCutoverSloSnapshotsToFileSync,
} from "@dofe-agent/db";
import { sendPrismaCutoverSloPagerAlert } from "../observability/prisma-cutover-slo-pager.ts";
import { publishPrismaCutoverRollbacksFromEnv } from "../observability/prisma-cutover-rollback-publisher.ts";
import { readBoundedNumber, readSloThresholdsFromEnv } from "../shared/slo-thresholds.ts";

export interface RuntimeMaintenanceStageResult {
  status: "succeeded" | "failed";
  value?: unknown;
  error?: string;
}

export interface RuntimeMaintenanceResult {
  ok: boolean;
  status: "succeeded" | "partial_failure";
  runId: string;
  evidence: RuntimeMaintenanceStageResult;
  stages: {
    provisioning: RuntimeMaintenanceStageResult;
    cleanup: RuntimeMaintenanceStageResult;
    usageRetries: RuntimeMaintenanceStageResult;
    usageReconciliation: RuntimeMaintenanceStageResult;
    mcpHealthChecks: RuntimeMaintenanceStageResult;
    recovery: RuntimeMaintenanceStageResult;
    skillOperationLeases: RuntimeMaintenanceStageResult;
    lifecycle: RuntimeMaintenanceStageResult;
    skillServiceRetire?: RuntimeMaintenanceStageResult;
    commitReconciliation?: RuntimeMaintenanceStageResult;
    legacySkillMigration?: RuntimeMaintenanceStageResult;
    sloFlush?: RuntimeMaintenanceStageResult;
    sloPager?: RuntimeMaintenanceStageResult;
    sloArchive?: RuntimeMaintenanceStageResult;
    sloRollback?: RuntimeMaintenanceStageResult;
  };
}

export interface RuntimeMaintenanceDependencies {
  createRun: () => { id: string };
  completeRun: (input: {
    id: string;
    status: "succeeded" | "partial_failure";
    stages: Record<string, unknown>;
  }) => unknown;
  heartbeatRun?: (id: string) => unknown;
  heartbeatIntervalMs?: number;
  resumeProvisioning: () => Promise<unknown>;
  resumeCleanup: () => Promise<unknown>;
  drainUsageRetries: () => unknown;
  reconcileUsage: () => Promise<unknown>;
  scheduleMcpHealthChecks: () => unknown;
  advanceRecoveries: () => unknown;
  requeueSkillOperationLeases: () => unknown;
  lifecycle: () => unknown;
  /** Optional web-side stage: re-drives stale preparing_commit journals. */
  commitReconciliation?: () => unknown;
  /** Optional stage: retires managed skill services the last installation left. */
  retireSkillServices?: () => unknown;
  /** Optional stage: backfills legacy skills into DSP artifacts (Phase 6.1). */
  migrateLegacySkills?: () => unknown;
  /** Periodically persists the process SLO window to the central ledger. */
  flushSlo?: () => unknown;
  /** Pages on the centrally aggregated SLO window and emits recoveries. */
  pageSlo?: () => Promise<unknown>;
  /** Archives and prunes expired central SLO ledger snapshots. */
  archiveSlo?: () => unknown;
  /** Publishes opt-in SLO rollback recommendations to the release system. */
  rollbackSlo?: () => Promise<unknown>;
}

export const defaultDependencies: RuntimeMaintenanceDependencies = {
  createRun: createRuntimeMaintenanceRunSync,
  completeRun: completeRuntimeMaintenanceRunSync,
  heartbeatRun: heartbeatRuntimeMaintenanceRunSync,
  resumeProvisioning: resumePendingProvisioningTasksAsync,
  resumeCleanup: resumeManagedRuntimeCleanupRequestsAsync,
  drainUsageRetries: drainTokenUsageRetriesSync,
  reconcileUsage: reconcileAllManagedRuntimeUsageAsync,
  scheduleMcpHealthChecks: scheduleMcpHealthChecksSync,
  advanceRecoveries: advanceRecoverableOperationsSync,
  requeueSkillOperationLeases: () => {
    requeueExpiredSkillInstallationOperationLeasesSync();
    requeueExpiredManagedSkillServiceOperationLeasesSync();
  },
  lifecycle: () => runEmployeeLifecycleMaintenanceSync(),
  retireSkillServices: () => retireUnreferencedManagedSkillServicesSync(),
  migrateLegacySkills: () => migrateAllWorkspaceLegacySkillsSync(),
  flushSlo: () => flushPrismaCutoverSloSnapshotsSync(readSloFlushInputFromEnv()),
  pageSlo: () => sendPrismaCutoverSloPagerAlert(readSloPagerInputFromEnv()),
  archiveSlo: () => archivePrismaCutoverSloSnapshotsToFileSync({
    archiveDir: process.env.PRISMA_CUTOVER_SLO_ARCHIVE_DIR,
    workspaceId: process.env.PRISMA_CUTOVER_SLO_WORKSPACE_ID?.trim() || "default",
    retentionDays: readBoundedNumber(process.env.PRISMA_CUTOVER_SLO_RETENTION_DAYS, 30, 1, 3_650),
  }),
  rollbackSlo: () => publishPrismaCutoverRollbacksFromEnv({
    workspaceId: process.env.PRISMA_CUTOVER_SLO_WORKSPACE_ID?.trim() || "default",
    windowSeconds: readBoundedNumber(process.env.PRISMA_CUTOVER_SLO_WINDOW_SECONDS, 900, 60, 86_400),
  }),
};

export async function runRuntimeMaintenanceAsync(
  dependencies: RuntimeMaintenanceDependencies = defaultDependencies,
): Promise<RuntimeMaintenanceResult> {
  const run = dependencies.createRun();
  const runId = run.id;
  let evidence: RuntimeMaintenanceStageResult = { status: "succeeded" };
  let leaseHealthy = true;
  const heartbeat = (): void => {
    if (!dependencies.heartbeatRun || !leaseHealthy) return;
    try {
      dependencies.heartbeatRun(runId);
    } catch (error) {
      leaseHealthy = false;
      evidence = toFailedStage(error);
    }
  };
  heartbeat();
  const heartbeatTimer = dependencies.heartbeatRun
    ? setInterval(heartbeat, dependencies.heartbeatIntervalMs ?? 30_000)
    : undefined;
  heartbeatTimer?.unref();
  const stages = {} as RuntimeMaintenanceResult["stages"];
  type StageName = keyof RuntimeMaintenanceResult["stages"];
  const operations: Array<readonly [StageName, () => unknown]> = [
    ["provisioning", dependencies.resumeProvisioning],
    ["cleanup", dependencies.resumeCleanup],
    ["usageRetries", dependencies.drainUsageRetries],
    ["usageReconciliation", dependencies.reconcileUsage],
    ["mcpHealthChecks", dependencies.scheduleMcpHealthChecks],
    ["recovery", dependencies.advanceRecoveries],
    ["skillOperationLeases", dependencies.requeueSkillOperationLeases],
    ["lifecycle", dependencies.lifecycle],
    ...(dependencies.retireSkillServices ? [["skillServiceRetire", dependencies.retireSkillServices] as const] : []),
    ...(dependencies.commitReconciliation ? [["commitReconciliation", dependencies.commitReconciliation] as const] : []),
    ...(dependencies.migrateLegacySkills ? [["legacySkillMigration", dependencies.migrateLegacySkills] as const] : []),
    ...(dependencies.flushSlo ? [["sloFlush", dependencies.flushSlo] as const] : []),
    ...(dependencies.pageSlo ? [["sloPager", dependencies.pageSlo] as const] : []),
    ...(dependencies.archiveSlo ? [["sloArchive", dependencies.archiveSlo] as const] : []),
    ...(dependencies.rollbackSlo ? [["sloRollback", dependencies.rollbackSlo] as const] : []),
  ];
  for (const [name, operation] of operations) {
    stages[name] = leaseHealthy
      ? await runStage(operation)
      : { status: "failed", error: "runtime_maintenance.lease_lost" };
    heartbeat();
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeat();
  const stagesSucceeded = Object.values(stages).every((stage) => stage.status === "succeeded");
  const persistedStatus = stagesSucceeded ? "succeeded" : "partial_failure";
  try {
    dependencies.completeRun({ id: runId, status: persistedStatus, stages });
  } catch (error) {
    evidence = toFailedStage(error);
  }
  const ok = stagesSucceeded && evidence.status === "succeeded";
  const status = ok ? "succeeded" : "partial_failure";
  const alerts = ok ? [] : buildRuntimeMaintenanceFailureAlerts(runId, stages, evidence);
  // Reconcile on successful runs too: an empty alert set is what lets the
  // pager emit recovery and retire a state created by a previous failed run.
  await sendExternalPagerAlert({
    source: "dofe-agent-runtime-maintenance",
    alerts,
    checkedAt: new Date().toISOString(),
    recoveryCodes: RUNTIME_MAINTENANCE_ALERT_CODES,
  });
  return { ok, status, runId, evidence, stages };
}

/**
 * 维护任务失败告警的全部 code：pager recovery 检测的作用域。
 * 限定后 SLO pager 等相邻告警域的活跃状态不会被本域误清（复审 P0）。
 */
const RUNTIME_MAINTENANCE_ALERT_CODES = [
  "runtime_maintenance_stage_failed",
  "runtime_maintenance_persistence_failed",
  "runtime_maintenance_unknown_failure",
] as const;

function readSloFlushInputFromEnv(): {
  thresholds: PrismaCutoverSloThresholds;
  instanceId: string;
  workspaceId: string;
  now: string;
} {
  const now = new Date().toISOString();
  return {
    thresholds: readSloThresholdsFromEnv(),
    instanceId: readSloInstanceIdFromEnv(),
    workspaceId: process.env.PRISMA_CUTOVER_SLO_WORKSPACE_ID?.trim() || "default",
    now,
  };
}

function readSloPagerInputFromEnv(): {
  thresholds: PrismaCutoverSloThresholds;
  workspaceId: string;
  checkedAt: string;
  windowSeconds: number;
} {
  return {
    thresholds: readSloThresholdsFromEnv(),
    workspaceId: process.env.PRISMA_CUTOVER_SLO_WORKSPACE_ID?.trim() || "default",
    checkedAt: new Date().toISOString(),
    windowSeconds: readBoundedNumber(process.env.PRISMA_CUTOVER_SLO_WINDOW_SECONDS, 900, 60, 86_400),
  };
}

function readSloInstanceIdFromEnv(): string {
  const configured = process.env.PRISMA_CUTOVER_SLO_INSTANCE_ID?.trim();
  if (configured) return configured;
  const hostname = process.env.HOSTNAME?.trim();
  if (hostname) return hostname;
  return `runtime-maintenance-${process.pid}`;
}

function buildRuntimeMaintenanceFailureAlerts(
  runId: string,
  stages: RuntimeMaintenanceResult["stages"],
  evidence: RuntimeMaintenanceStageResult,
): Array<{ code: string; severity: "error"; message: string; metric?: string; value?: number }> {
  const alerts: Array<{ code: string; severity: "error"; message: string; metric?: string; value?: number }> = [];
  let failedStages = 0;
  for (const [name, result] of Object.entries(stages)) {
    if (result.status === "failed") {
      failedStages += 1;
      alerts.push({
        code: "runtime_maintenance_stage_failed",
        severity: "error",
        message: `Runtime maintenance stage "${name}" failed: ${result.error ?? "unknown error"} (run ${runId}).`,
        metric: "runtime_maintenance_failed_stage",
      });
    }
  }
  if (evidence.status === "failed") {
    alerts.push({
      code: "runtime_maintenance_persistence_failed",
      severity: "error",
      message: `Runtime maintenance persistence/heartbeat failed: ${evidence.error ?? "unknown error"} (run ${runId}).`,
    });
  }
  if (failedStages === 0 && evidence.status === "succeeded") {
    alerts.push({
      code: "runtime_maintenance_unknown_failure",
      severity: "error",
      message: `Runtime maintenance reported a failure with no explicit failed stage (run ${runId}).`,
    });
  }
  return alerts;
}

async function runStage(operation: () => unknown | Promise<unknown>): Promise<RuntimeMaintenanceStageResult> {
  try {
    return { status: "succeeded", value: await operation() };
  } catch (error) {
    return toFailedStage(error);
  }
}

function toFailedStage(error: unknown): RuntimeMaintenanceStageResult {
  return {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}
