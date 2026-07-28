import { randomUUID } from "node:crypto";
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
  };
}

interface RuntimeMaintenanceDependencies {
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
}

const defaultDependencies: RuntimeMaintenanceDependencies = {
  createRun: createRuntimeMaintenanceRunSync,
  completeRun: completeRuntimeMaintenanceRunSync,
  heartbeatRun: heartbeatRuntimeMaintenanceRunSync,
  resumeProvisioning: resumePendingProvisioningTasksAsync,
  resumeCleanup: resumeManagedRuntimeCleanupRequestsAsync,
  drainUsageRetries: drainTokenUsageRetriesSync,
  reconcileUsage: reconcileAllManagedRuntimeUsageAsync,
};

export async function runRuntimeMaintenanceAsync(
  dependencies: RuntimeMaintenanceDependencies = defaultDependencies,
): Promise<RuntimeMaintenanceResult> {
  let runId = `maintenance-unpersisted-${randomUUID()}`;
  let persisted = false;
  let evidence: RuntimeMaintenanceStageResult = { status: "succeeded" };
  try {
    const run = dependencies.createRun();
    runId = run.id;
    persisted = true;
  } catch (error) {
    if (error instanceof Error && error.message === "runtime_maintenance.already_running") throw error;
    evidence = toFailedStage(error);
  }
  const heartbeat = (): void => {
    if (!persisted || !dependencies.heartbeatRun) return;
    try {
      dependencies.heartbeatRun(runId);
    } catch (error) {
      evidence = toFailedStage(error);
    }
  };
  heartbeat();
  const heartbeatTimer = persisted && dependencies.heartbeatRun
    ? setInterval(heartbeat, dependencies.heartbeatIntervalMs ?? 30_000)
    : undefined;
  heartbeatTimer?.unref();
  const stages = {
    provisioning: await runStage(dependencies.resumeProvisioning),
    cleanup: await runStage(dependencies.resumeCleanup),
    usageRetries: await runStage(dependencies.drainUsageRetries),
    usageReconciliation: await runStage(dependencies.reconcileUsage),
  };
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeat();
  const stagesSucceeded = Object.values(stages).every((stage) => stage.status === "succeeded");
  const persistedStatus = stagesSucceeded ? "succeeded" : "partial_failure";
  if (persisted) {
    try {
      dependencies.completeRun({ id: runId, status: persistedStatus, stages });
    } catch (error) {
      evidence = toFailedStage(error);
    }
  }
  const ok = stagesSucceeded && evidence.status === "succeeded";
  const status = ok ? "succeeded" : "partial_failure";
  return { ok, status, runId, evidence, stages };
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
