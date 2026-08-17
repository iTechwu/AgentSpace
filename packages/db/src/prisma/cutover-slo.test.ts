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

test("cutover SLO window aggregates weighted batch samples with partial failures", () => {
  const window = new PrismaCutoverSloWindow(10);
  // 批次一：100 条中 2 条结构化失败 + 1 次成功重试的 P2034 冲突。
  window.record({ domain: "workflow-dispatcher" }, {
    source: "primary", mismatch: 0, shadowCompared: 0, durationMs: 500, fallbackInvoked: 0,
    sampleCount: 100, errorCount: 2, p2034Count: 1,
  });
  // 批次二：全成功。
  window.record({ domain: "workflow-dispatcher" }, {
    source: "primary", mismatch: 0, shadowCompared: 0, durationMs: 300, fallbackInvoked: 0,
    sampleCount: 50,
  });
  const [snapshot] = window.snapshots({
    thresholds: {
      ...thresholds,
      minimumSamples: 150,
      maximumErrorRate: 0.01,
      maximumP2034Rate: 0,
    },
  });
  assert.equal(snapshot?.sampleCount, 150);
  assert.equal(snapshot?.errorRate, 2 / 150);
  assert.equal(snapshot?.p2034Rate, 1 / 150);
  assert.equal(snapshot?.deadlockRate, 0);
  // 部分失败的批次不再被记成纯成功样本。
  assert.ok(snapshot?.rollbackReasons.includes("error_rate"));
  assert.ok(snapshot?.rollbackReasons.includes("p2034_rate"));
});

test("cutover SLO window caps absurd batch weights and keeps rates within [0,1]", () => {
  const window = new PrismaCutoverSloWindow(10);
  window.record({ domain: "workflow-materialization" }, {
    source: "primary", mismatch: 0, durationMs: 10, fallbackInvoked: 0,
    sampleCount: 1_000_000, errorCount: 999_999,
  });
  const [snapshot] = window.snapshots({ thresholds });
  assert.equal(snapshot?.sampleCount, 10_000);
  assert.equal(snapshot?.errorRate, 1);
});

test("cutover SLO window drops empty batches so idle polls never inflate samples", () => {
  const window = new PrismaCutoverSloWindow(10);
  // 空闲轮询：没有认领任何触发器/没有发布任何 outbox 条目——不是观测。
  window.record({ domain: "workflow-dispatcher" }, {
    source: "primary", mismatch: 0, shadowCompared: 0, durationMs: 5, fallbackInvoked: 0,
    sampleCount: 0, errorCount: 0,
  });
  window.record({ domain: "workflow-materialization" }, {
    source: "primary", mismatch: 0, shadowCompared: 0, durationMs: 5, fallbackInvoked: 0,
    sampleCount: 0, errorCount: 0,
  });
  assert.deepEqual(window.snapshots({ thresholds }), []);
});

test("cutover SLO window still records an empty-declared batch that carries failures", () => {
  const window = new PrismaCutoverSloWindow(10);
  // 分母声明为 0 但带失败计数：失败必须留痕，权重由计数兜底。
  window.record({ domain: "workflow-dispatcher" }, {
    source: "primary", mismatch: 0, shadowCompared: 0, durationMs: 5, fallbackInvoked: 0,
    sampleCount: 0, errorCount: 2,
  });
  const [snapshot] = window.snapshots({ thresholds });
  assert.equal(snapshot?.sampleCount, 2);
  assert.equal(snapshot?.errorRate, 1);
});
