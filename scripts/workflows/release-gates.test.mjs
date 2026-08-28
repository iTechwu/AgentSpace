import assert from "node:assert/strict";
import test from "node:test";

import { parseFailureDrillOptions, runFailureDrill } from "./failure-drill.mjs";
import { LOAD_LIMITS, parseLoadOptions, runWorkflowLoad } from "./load-test.mjs";

test("load test enforces workspace, run and concurrency boundaries", () => {
  assert.deepEqual(parseLoadOptions(["--workspace-id", "workflow-load-test-a", "--runs", "100"]), {
    workspaceId: "workflow-load-test-a",
    triggers: LOAD_LIMITS.triggers,
    runs: 100,
    concurrency: LOAD_LIMITS.concurrency,
    execute: false,
  });
  assert.throws(() => parseLoadOptions(["--workspace-id", "production", "--runs", "1"]), /not_isolated/);
  assert.throws(() => parseLoadOptions(["--runs", "101"]), /runs_out_of_bounds/);
  assert.throws(() => parseLoadOptions(["--concurrency", "21"]), /concurrency_out_of_bounds/);
});

test("simulated load test satisfies the release thresholds", async () => {
  const report = await runWorkflowLoad(parseLoadOptions(["--runs", "100"]));
  assert.equal(report.passed, true);
  assert.ok(report.triggerLagSeconds.p95 <= 60);
  assert.equal(report.duplicateRuns, 0);
  assert.equal(report.duplicateDownstreamTasks, 0);
});

test("execute mode requires an explicit isolated test environment and adapter", async () => {
  await assert.rejects(
    runWorkflowLoad(parseLoadOptions(["--execute"]), {}),
    /workflow_test_node_env_required/,
  );
});

test("failure drill covers four recovery scenarios and rejects production workspaces", async () => {
  assert.throws(() => parseFailureDrillOptions(["--workspace-id", "default"]), /not_isolated/);
  const report = await runFailureDrill(parseFailureDrillOptions([]));
  assert.equal(report.passed, true);
  assert.equal(report.cleanupPerformed, true);
  assert.deepEqual(report.scenarios.map((item) => item.scenario), [
    "worker_stop_recovery",
    "duplicate_completion",
    "event_sequence_gap",
    "runtime_offline",
  ]);
});
