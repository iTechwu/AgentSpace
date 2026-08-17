import assert from "node:assert/strict";
import test from "node:test";
import { assessPrismaCutoverShadowReadiness } from "./cutover-shadow-readiness.ts";

function snapshot(windowStart: string, windowEnd: string, overrides: Record<string, unknown> = {}) {
  return {
    domain: "workflow-dispatcher",
    sampleCount: 120,
    mismatchRate: 0,
    shadowComparisonRate: 1,
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

test("shadow readiness fails closed for malformed persisted evidence", () => {
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [
      snapshot("2026-07-18T00:00:00.000Z", "2026-08-17T00:00:00.000Z", {
        sampleCount: Number.NaN,
        mismatchRate: 2,
      }),
    ],
  });

  assert.equal(result.ready, false);
  assert.equal(result.sampleCount, 0);
  assert.ok(Number.isFinite(result.sampleCount));
  assert.ok(result.reasons.includes("invalid_snapshot"));
});

test("shadow readiness rejects successful samples that were never compared", () => {
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [snapshot("2026-07-18T00:00:00.000Z", "2026-08-17T00:00:00.000Z", {
      shadowComparisonRate: 0,
    })],
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("shadow_comparison_missing"));
});
