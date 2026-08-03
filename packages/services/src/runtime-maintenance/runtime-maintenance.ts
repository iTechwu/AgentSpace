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
import {
  requeueExpiredManagedSkillServiceOperationLeasesSync,
  requeueExpiredSkillInstallationOperationLeasesSync,
} from "@dofe-agent/db";

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
  if (!ok) {
    const alerts = buildRuntimeMaintenanceFailureAlerts(runId, stages, evidence);
    await sendExternalPagerAlert({ alerts, checkedAt: new Date().toISOString() });
  }
  return { ok, status, runId, evidence, stages };
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
