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
  window.record({ domain: "notifications" }, { source: "primary", mismatch: 0, durationMs: 10 });
  window.record({ domain: "notifications" }, { source: "primary", mismatch: 1, durationMs: 20 });
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
    fallbackRate: 0.25,
    errorRate: 0.25,
    p95DurationMs: 200,
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
