import assert from "node:assert/strict";
import test from "node:test";
import { runRuntimeMaintenanceAsync } from "./runtime-maintenance.ts";

test("runtime maintenance isolates stage failures and persists complete run evidence", async () => {
  const calls: string[] = [];
  let completed: Record<string, unknown> | undefined;
  const result = await runRuntimeMaintenanceAsync({
    createRun: () => ({ id: "maintenance-1" }),
    completeRun: (input) => {
      completed = input;
    },
    resumeProvisioning: async () => {
      calls.push("provisioning");
      throw new Error("provisioning unavailable");
    },
    resumeCleanup: async () => {
      calls.push("cleanup");
      return { resumed: 2 };
    },
    drainUsageRetries: () => {
      calls.push("usageRetries");
      throw new Error("retry queue unavailable");
    },
    reconcileUsage: async () => {
      calls.push("usageReconciliation");
      return { reconciledCount: 3 };
    },
  });

  assert.deepEqual(calls, ["provisioning", "cleanup", "usageRetries", "usageReconciliation"]);
  assert.equal(result.ok, false);
  assert.equal(result.status, "partial_failure");
  assert.equal(result.stages.provisioning.status, "failed");
  assert.equal(result.stages.cleanup.status, "succeeded");
  assert.equal(result.stages.usageRetries.status, "failed");
  assert.equal(result.stages.usageReconciliation.status, "succeeded");
  assert.equal(completed?.id, "maintenance-1");
  assert.equal(completed?.status, "partial_failure");
});
