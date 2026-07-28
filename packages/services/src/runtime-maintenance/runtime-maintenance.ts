import {
  completeRuntimeMaintenanceRunSync,
  createRuntimeMaintenanceRunSync,
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
  resumeProvisioning: () => Promise<unknown>;
  resumeCleanup: () => Promise<unknown>;
  drainUsageRetries: () => unknown;
  reconcileUsage: () => Promise<unknown>;
}

const defaultDependencies: RuntimeMaintenanceDependencies = {
  createRun: createRuntimeMaintenanceRunSync,
  completeRun: completeRuntimeMaintenanceRunSync,
  resumeProvisioning: resumePendingProvisioningTasksAsync,
  resumeCleanup: resumeManagedRuntimeCleanupRequestsAsync,
  drainUsageRetries: drainTokenUsageRetriesSync,
  reconcileUsage: reconcileAllManagedRuntimeUsageAsync,
};

export async function runRuntimeMaintenanceAsync(
  dependencies: RuntimeMaintenanceDependencies = defaultDependencies,
): Promise<RuntimeMaintenanceResult> {
  const run = dependencies.createRun();
  const stages = {
    provisioning: await runStage(dependencies.resumeProvisioning),
    cleanup: await runStage(dependencies.resumeCleanup),
    usageRetries: await runStage(dependencies.drainUsageRetries),
    usageReconciliation: await runStage(dependencies.reconcileUsage),
  };
  const ok = Object.values(stages).every((stage) => stage.status === "succeeded");
  const status = ok ? "succeeded" : "partial_failure";
  dependencies.completeRun({ id: run.id, status, stages });
  return { ok, status, runId: run.id, stages };
}

async function runStage(operation: () => unknown | Promise<unknown>): Promise<RuntimeMaintenanceStageResult> {
  try {
    return { status: "succeeded", value: await operation() };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
