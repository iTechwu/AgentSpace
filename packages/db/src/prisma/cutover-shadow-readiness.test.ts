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

test("shadow readiness requires a continuous zero-drift window", () => {
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [
      snapshot("2026-08-15T00:00:00.000Z", "2026-08-16T00:00:00.000Z"),
      snapshot("2026-08-16T00:00:00.000Z", "2026-08-17T00:00:00.000Z"),
    ],
    requiredWindowDays: 2,
    maximumGapSeconds: 60,
    // 单窗口跨度上限默认 1 小时且最大 1 天；本用例用两个整日窗口验证连续覆盖判定本身。
    maximumWindowSpanSeconds: 86_400,
    minimumSamples: 240,
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
      snapshot("2026-08-15T00:00:00.000Z", "2026-08-16T00:00:00.000Z"),
      snapshot("2026-08-16T12:00:00.000Z", "2026-08-17T00:00:00.000Z", { mismatchRate: 0.01 }),
    ],
    requiredWindowDays: 2,
    maximumWindowSpanSeconds: 86_400,
    minimumSamples: 240,
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
    snapshots: [snapshot("2026-08-16T00:00:00.000Z", "2026-08-17T00:00:00.000Z", {
      shadowComparisonRate: 0,
    })],
    requiredWindowDays: 1,
    maximumWindowSpanSeconds: 86_400,
    minimumSamples: 120,
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("shadow_comparison_missing"));
});

test("shadow readiness defaults require sustained sampling, not one long window", () => {
  // 单个覆盖 30 天的窗口：样本数足够也必须被拒——跨度超过默认 1 小时上限。
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [snapshot("2026-07-18T00:00:00.000Z", "2026-08-17T00:00:00.000Z", {
      sampleCount: 10_000,
    })],
  });

  assert.equal(result.ready, false);
  assert.equal(result.maximumWindowSpanSeconds, 3_600);
  assert.ok(result.reasons.includes("window_span_exceeded"));
  assert.ok(result.reasons.includes("no_snapshots"));
});

test("shadow readiness defaults demand 1000 samples across continuous short windows", () => {
  // 两小时的证据（合法跨度窗口）不足以满足默认样本下限 1000。
  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [snapshot("2026-08-16T23:00:00.000Z", "2026-08-17T00:00:00.000Z")],
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("insufficient_samples"));
  assert.ok(result.reasons.includes("insufficient_coverage"));
});

test("shadow readiness accepts sustained hourly windows meeting the default gates", () => {
  // 30 天 × 每小时一个 50 分钟窗口 × 每窗 2 样本 = 1440 样本，持续采集可通过默认门禁。
  const now = Date.parse("2026-08-17T00:00:00.000Z");
  const base = now - 30 * 86_400_000;
  const snapshots = Array.from({ length: 24 * 30 }, (_, index) => {
    const start = base + index * 3_600_000;
    return snapshot(new Date(start).toISOString(), new Date(start + 3_000_000).toISOString(), { sampleCount: 2 });
  });

  const result = assessPrismaCutoverShadowReadiness({
    domain: "workflow-dispatcher",
    now: "2026-08-17T00:00:00.000Z",
    snapshots,
  });

  assert.equal(result.ready, true);
  assert.equal(result.sampleCount, 1_440);
  assert.deepEqual(result.reasons, []);
});
