import assert from "node:assert/strict";
import test from "node:test";
import { emitPrismaCutoverMetric } from "./cutover-observability.ts";
import { PrismaCutoverSloWindow } from "./cutover-slo.ts";

test("does not emit cutover metrics while observability is disabled", () => {
  const lines: string[] = [];
  emitPrismaCutoverMetric(
    { domain: "audit_log", operation: "list" },
    { source: "fallback", mismatch: 0, durationMs: 12, error: "secret=hidden" },
    {
      env: {},
      logger: { info: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) },
    },
  );
  assert.deepEqual(lines, []);
});

test("always emits abnormal metrics without exposing the error message", () => {
  const lines: string[] = [];
  emitPrismaCutoverMetric(
    { domain: "audit_log", operation: "list" },
    { source: "fallback", mismatch: 0, durationMs: 12, error: "postgres://user:secret@example/db" },
    {
      env: { PRISMA_CUTOVER_METRICS_ENABLED: "1", PRISMA_CUTOVER_SUCCESS_SAMPLE_RATE: "0" },
      logger: { info: () => assert.fail("abnormal metric must use warn"), warn: (line) => lines.push(String(line)) },
    },
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes("secret"), false);
  assert.deepEqual(JSON.parse(lines[0]!), {
    eventCode: "prisma.cutover",
    domain: "audit_log",
    operation: "list",
    source: "fallback",
    mismatch: 0,
    durationMs: 12,
    error: "present",
  });
});

test("samples successful primary reads at the configured rate", () => {
  const lines: string[] = [];
  const options = {
    env: { PRISMA_CUTOVER_METRICS_ENABLED: "1", PRISMA_CUTOVER_SUCCESS_SAMPLE_RATE: "0.25" },
    logger: { info: (line: unknown) => lines.push(String(line)), warn: () => assert.fail("success must use info") },
  };

  emitPrismaCutoverMetric(
    { domain: "notifications", operation: "list" },
    { source: "primary", mismatch: 0, durationMs: 4 },
    { ...options, random: () => 0.5 },
  );
  emitPrismaCutoverMetric(
    { domain: "notifications", operation: "list" },
    { source: "primary", mismatch: 0, durationMs: 4 },
    { ...options, random: () => 0.1 },
  );

  assert.equal(lines.length, 1);
});

test("records every enabled metric in the SLO window before log sampling", () => {
  const window = new PrismaCutoverSloWindow();
  emitPrismaCutoverMetric(
    { domain: "notifications", operation: "list" },
    { source: "primary", mismatch: 0, durationMs: 4 },
    {
      env: { PRISMA_CUTOVER_METRICS_ENABLED: "1", PRISMA_CUTOVER_SUCCESS_SAMPLE_RATE: "0" },
      random: () => 1,
      sloWindow: window,
      logger: { info: () => assert.fail("sampled log must be skipped"), warn: () => assert.fail("success must not warn") },
    },
  );
  assert.equal(window.snapshots({
    thresholds: {
      minimumSamples: 1,
      maximumMismatchRate: 1,
      maximumFallbackRate: 1,
      maximumErrorRate: 1,
      maximumP95DurationMs: 100,
    },
  })[0]?.sampleCount, 1);
});
