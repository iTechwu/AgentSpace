import assert from "node:assert/strict";
import test from "node:test";
import { PrismaCutoverSloWindow } from "./cutover-slo.ts";

const thresholds = {
  minimumSamples: 4,
  maximumMismatchRate: 0.2,
  maximumFallbackRate: 0.2,
  maximumErrorRate: 0.2,
  maximumP95DurationMs: 100,
};

test("cutover SLO window aggregates domain rates, P95, and rollback reasons", () => {
  const window = new PrismaCutoverSloWindow(10);
  window.record({ domain: "notifications" }, { source: "primary", mismatch: 0, shadowCompared: 1, durationMs: 10 });
  window.record({ domain: "notifications" }, { source: "primary", mismatch: 1, shadowCompared: 1, durationMs: 20 });
  window.record({ domain: "notifications" }, { source: "fallback", mismatch: 0, durationMs: 30, error: "present" });
  window.record({ domain: "notifications" }, { source: "primary", mismatch: 0, durationMs: 200 });

  assert.deepEqual(window.snapshots({
    thresholds,
    flagVersion: "flags-v2",
    lastKnownGoodFlagVersion: "flags-v1",
  }), [{
    domain: "notifications",
    sampleCount: 4,
    mismatchRate: 0.25,
    shadowComparisonRate: 0.5,
    fallbackRate: 0.25,
    errorRate: 0.25,
    p95DurationMs: 200,
    deadlockRate: 0,
    p2034Rate: 0,
    burnRate: 1.25,
    rollbackRecommended: true,
    rollbackReasons: ["mismatch_rate", "fallback_rate", "error_rate", "p95_duration"],
    flagVersion: "flags-v2",
    lastKnownGoodFlagVersion: "flags-v1",
  }]);
});

test("cutover SLO window is bounded and waits for its minimum sample count", () => {
  const window = new PrismaCutoverSloWindow(2);
  window.record({ domain: "audit_log" }, { source: "fallback", mismatch: 1, durationMs: 500, error: "present" });
  window.record({ domain: "audit_log" }, { source: "primary", mismatch: 0, durationMs: 10 });
  window.record({ domain: "audit_log" }, { source: "primary", mismatch: 0, durationMs: 20 });

  const [snapshot] = window.snapshots({ thresholds });
  assert.equal(snapshot?.sampleCount, 2);
  assert.equal(snapshot?.mismatchRate, 0);
  assert.equal(snapshot?.rollbackRecommended, false);
});

test("cutover SLO classifies deadlock/P2034 and exposes burn-rate alerts", () => {
  const window = new PrismaCutoverSloWindow(10);
  window.record({ domain: "task-queue" }, { source: "primary", mismatch: 0, durationMs: 10, error: "deadlock detected (40P01)" });
  window.record({ domain: "task-queue" }, { source: "primary", mismatch: 0, durationMs: 10, error: "P2034: could not serialize access" });
  const [snapshot] = window.snapshots({
    thresholds: {
      ...thresholds,
      minimumSamples: 2,
      maximumDeadlockRate: 0,
      maximumP2034Rate: 0,
    },
  });
  assert.equal(snapshot?.deadlockRate, 0.5);
  assert.equal(snapshot?.p2034Rate, 0.5);
  assert.equal(snapshot?.burnRate, 5);
  assert.deepEqual(snapshot?.rollbackReasons, ["error_rate", "deadlock_rate", "p2034_rate"]);
});
