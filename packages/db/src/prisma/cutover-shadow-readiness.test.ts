import assert from "node:assert/strict";
import test from "node:test";
import { assessPrismaCutoverShadowReadiness } from "./cutover-shadow-readiness.ts";

function snapshot(windowStart: string, windowEnd: string, overrides: Record<string, unknown> = {}) {
  return {
    domain: "workflow-dispatcher",
    sampleCount: 120,
    mismatchRate: 0,
    fallbackRate: 0,
    errorRate: 0,
    deadlockRate: 0,
    p2034Rate: 0,
    p95DurationMs: 20,
    burnRate: 0,
    rollbackRecommended: false,
    rollbackReasons: [],
    windowStart,
    windowEnd,
    ...overrides,
  };
}

test("shadow readiness requires a continuous 30-day zero-drift window", () => {
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [
      snapshot("2026-07-18T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
      snapshot("2026-08-01T00:00:00.000Z", "2026-08-17T00:00:00.000Z"),
    ],
    maximumGapSeconds: 60,
  });

  assert.equal(result.ready, true);
  assert.equal(result.sampleCount, 240);
  assert.deepEqual(result.reasons, []);
});

test("shadow readiness names gaps and non-zero drift as blocking reasons", () => {
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [
      snapshot("2026-07-18T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
      snapshot("2026-08-02T00:00:00.000Z", "2026-08-17T00:00:00.000Z", { mismatchRate: 0.01 }),
    ],
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("coverage_gap"));
  assert.ok(result.reasons.includes("mismatch_observed"));
});
