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
  scheduleMcpHealthChecks: () => unknown;
}

const defaultDependencies: RuntimeMaintenanceDependencies = {
  createRun: createRuntimeMaintenanceRunSync,
  completeRun: completeRuntimeMaintenanceRunSync,
  heartbeatRun: heartbeatRuntimeMaintenanceRunSync,
  resumeProvisioning: resumePendingProvisioningTasksAsync,
  resumeCleanup: resumeManagedRuntimeCleanupRequestsAsync,
  drainUsageRetries: drainTokenUsageRetriesSync,
  reconcileUsage: reconcileAllManagedRuntimeUsageAsync,
  scheduleMcpHealthChecks: scheduleMcpHealthChecksSync,
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
  const operations = [
    ["provisioning", dependencies.resumeProvisioning],
    ["cleanup", dependencies.resumeCleanup],
    ["usageRetries", dependencies.drainUsageRetries],
    ["usageReconciliation", dependencies.reconcileUsage],
    ["mcpHealthChecks", dependencies.scheduleMcpHealthChecks],
  ] as const;
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
