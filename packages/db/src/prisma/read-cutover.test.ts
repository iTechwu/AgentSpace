// Unit tests for the generic read-cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import { withReadCutover } from "./read-cutover.ts";

test("withReadCutover returns fallback when flag is disabled", async () => {
  let primaryCalled = false;
  let fallbackCalled = false;

  const result = await withReadCutover({
    isEnabled: () => false,
    isShadowEnabled: () => true,
    runPrimary: async () => {
      primaryCalled = true;
      return "primary";
    },
    runFallback: () => {
      fallbackCalled = true;
      return "fallback";
    },
    compare: () => true,
    emitMetric: () => {},
  });

  assert.equal(result, "fallback");
  assert.equal(primaryCalled, false);
  assert.equal(fallbackCalled, true);
});

test("withReadCutover returns primary and compares when shadow is enabled", async () => {
  const metrics: Array<{ source: string; mismatch: number; error?: string }> = [];

  const result = await withReadCutover({
    isEnabled: () => true,
    isShadowEnabled: () => true,
    runPrimary: async () => "primary",
    runFallback: () => "fallback",
    compare: () => true,
    emitMetric: (metric) => metrics.push(metric),
  });

  assert.equal(result, "primary");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.mismatch, 0);
  assert.equal(metrics[0]!.shadowCompared, 1);
});

test("withReadCutover does not compare when shadow is disabled", async () => {
  const metrics: Array<{ source: string; mismatch: number; error?: string }> = [];

  const result = await withReadCutover({
    isEnabled: () => true,
    isShadowEnabled: () => false,
    runPrimary: async () => "primary",
    runFallback: () => {
      throw new Error("fallback should not be called");
    },
    compare: () => true,
    emitMetric: (metric) => metrics.push(metric),
  });

  assert.equal(result, "primary");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.mismatch, 0);
  assert.equal(metrics[0]!.shadowCompared, 0);
});

test("withReadCutover falls back to sync when primary fails", async () => {
  const metrics: Array<{ source: string; mismatch: number; error?: string }> = [];

  const result = await withReadCutover({
    isEnabled: () => true,
    isShadowEnabled: () => false,
    runPrimary: async () => {
      throw new Error("primary failure");
    },
    runFallback: () => "fallback",
    compare: () => true,
    emitMetric: (metric) => metrics.push(metric),
  });

  assert.equal(result, "fallback");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.mismatch, 0);
  assert.ok(metrics[0]!.error?.includes("primary failure"));
});

test("withReadCutover propagates primary error when fallback also fails", async () => {
  const metrics: Array<{ source: string; error?: string; fallbackFailed?: number }> = [];
  await assert.rejects(
    async () =>
      withReadCutover({
        isEnabled: () => true,
        isShadowEnabled: () => false,
        runPrimary: async () => {
          throw new Error("primary failure");
        },
        runFallback: () => {
          throw new Error("fallback failure");
        },
        compare: () => true,
        emitMetric: (metric) => metrics.push(metric),
      }),
    /primary failure/,
  );
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]?.source, "fallback");
  assert.equal(metrics[0]?.fallbackFailed, 1);
  assert.ok(metrics[0]?.error?.includes("primary failure"));
});

test("withReadCutover propagates shadow fallback error and does not fall back to it", async () => {
  const metrics: Array<{ source: string; mismatch: number; error?: string }> = [];

  await assert.rejects(
    async () =>
      withReadCutover({
        isEnabled: () => true,
        isShadowEnabled: () => true,
        runPrimary: async () => "primary",
        runFallback: () => {
          throw new Error("shadow fallback failure");
        },
        compare: () => true,
        emitMetric: (metric) => metrics.push(metric),
      }),
    /shadow fallback failure/,
  );

  // Mismatch metric should be emitted with the shadow error attached, and the
  // runner must not silently downgrade to the primary result.
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.mismatch, 1);
  assert.ok(metrics[0]!.error?.includes("shadow fallback failure"));
});

test("withReadCutover returns primary when emitMetric throws", async () => {
  const result = await withReadCutover({
    isEnabled: () => true,
    isShadowEnabled: () => true,
    runPrimary: async () => "primary",
    runFallback: () => "fallback",
    compare: () => true,
    emitMetric: () => {
      throw new Error("metric sink down");
    },
  });

  assert.equal(result, "primary");
});

test("withReadCutover returns fallback when primary fails and emitMetric throws", async () => {
  const result = await withReadCutover({
    isEnabled: () => true,
    isShadowEnabled: () => false,
    runPrimary: async () => {
      throw new Error("primary failure");
    },
    runFallback: () => "fallback",
    compare: () => true,
    emitMetric: () => {
      throw new Error("metric sink down");
    },
  });

  assert.equal(result, "fallback");
});
