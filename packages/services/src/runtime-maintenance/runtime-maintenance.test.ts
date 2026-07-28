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

test("runtime maintenance fails closed before stages when its run lease cannot be created", async () => {
  const calls: string[] = [];
  await assert.rejects(() => runRuntimeMaintenanceAsync({
    createRun: () => {
      throw new Error("evidence database unavailable");
    },
    completeRun: () => {
      throw new Error("must not complete an unpersisted run");
    },
    resumeProvisioning: async () => calls.push("provisioning"),
    resumeCleanup: async () => calls.push("cleanup"),
    drainUsageRetries: () => calls.push("usageRetries"),
    reconcileUsage: async () => calls.push("usageReconciliation"),
  }), /evidence database unavailable/);

  assert.deepEqual(calls, []);
});

test("runtime maintenance renews its lease while a long stage remains active", async () => {
  let finishProvisioning!: () => void;
  const provisioning = new Promise<void>((resolve) => {
    finishProvisioning = resolve;
  });
  let heartbeatCount = 0;
  const running = runRuntimeMaintenanceAsync({
    createRun: () => ({ id: "maintenance-long" }),
    completeRun: () => undefined,
    heartbeatRun: () => {
      heartbeatCount += 1;
    },
    heartbeatIntervalMs: 5,
    resumeProvisioning: () => provisioning,
    resumeCleanup: async () => undefined,
    drainUsageRetries: () => undefined,
    reconcileUsage: async () => undefined,
  });

  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.ok(heartbeatCount >= 2);
  finishProvisioning();
  assert.equal((await running).ok, true);
});

test("runtime maintenance stops subsequent stages and completion after lease loss", async () => {
  const calls: string[] = [];
  let heartbeatCount = 0;
  let completionAttempts = 0;
  const result = await runRuntimeMaintenanceAsync({
    createRun: () => ({ id: "maintenance-lost" }),
    completeRun: () => {
      completionAttempts += 1;
      throw new Error("runtime_maintenance.lease_lost");
    },
    heartbeatRun: () => {
      heartbeatCount += 1;
      if (heartbeatCount >= 2) throw new Error("runtime_maintenance.lease_lost");
    },
    resumeProvisioning: async () => calls.push("provisioning"),
    resumeCleanup: async () => calls.push("cleanup"),
    drainUsageRetries: () => calls.push("usageRetries"),
    reconcileUsage: async () => calls.push("usageReconciliation"),
  });

  assert.deepEqual(calls, ["provisioning"]);
  assert.equal(completionAttempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.stages.cleanup.status, "failed");
  assert.match(result.evidence.error ?? "", /lease_lost/);
});
