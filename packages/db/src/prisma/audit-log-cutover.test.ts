// Unit tests for the audit-log read-cutover runner.
//
// Tests run in an environment that may or may not have Postgres reachable:
// - Flag OFF: short-circuits to legacy sync read (no cutover, no metric).
// - Flag ON + shadow OFF: cutover runs primary; result must equal the seeded
//   record regardless of which path (primary or fallback) served it.
// - Flag ON + shadow ON: same correctness invariant + a metric is emitted
//   (source may be "primary" or "fallback" depending on PG reachability).
//
// The cutover wrapper is the integration surface, not the underlying
// comparison engine; comparing sync result vs cutover result validates
// behavior under both primary-up and primary-down conditions.

import assert from "node:assert/strict";
import test from "node:test";
import {
  recordAuditLogSync,
  readAuditLogSync,
} from "../audit-log.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  isAuditLogAsyncReadEnabled,
  isAuditLogShadowReadEnabled,
} from "./audit-log-async.ts";
import {
  readAuditLogCutover,
  type ReadAuditLogCutoverMetric,
} from "./audit-log-cutover.ts";

const ORIGINAL_ASYNC = process.env.AUDIT_LOG_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AUDIT_LOG_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AUDIT_LOG_ASYNC_READ_ENABLED;
  delete process.env.AUDIT_LOG_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.AUDIT_LOG_ASYNC_READ_ENABLED;
  else process.env.AUDIT_LOG_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AUDIT_LOG_SHADOW_READ_ENABLED;
  else process.env.AUDIT_LOG_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

function seedAuditLog(): AuditLogRecord {
  return recordAuditLogSync({
    workspaceId: "default",
    title: "cutover seed",
    note: "seeded for cutover test",
    code: "cutover.test.seed",
    source: "runtime_lifecycle",
    data: { marker: "fresh" },
  });
}

test("readAuditLogCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isAuditLogAsyncReadEnabled(), false);
  const seeded = seedAuditLog();
  const metrics: ReadAuditLogCutoverMetric[] = [];
  const result = await readAuditLogCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  assert.equal(result!.workspaceId, seeded.workspaceId);
  assert.equal(result!.title, seeded.title);
  assert.equal(result!.note, seeded.note);
  // Flag off → withReadCutover short-circuits to fallback, no metric emitted.
  assert.equal(metrics.length, 0);
});

test("readAuditLogCutover returns correct result with flag on (shadow off)", async () => {
  resetFlags();
  process.env.AUDIT_LOG_ASYNC_READ_ENABLED = "1";
  delete process.env.AUDIT_LOG_SHADOW_READ_ENABLED;

  const seeded = seedAuditLog();
  const metrics: ReadAuditLogCutoverMetric[] = [];
  const result = await readAuditLogCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  assert.equal(result!.workspaceId, seeded.workspaceId);
  assert.equal(result!.title, seeded.title);
  assert.equal(result!.note, seeded.note);
  // With primary reachable: source="primary" metric, mismatch=0.
  // With primary down: source="fallback" metric, mismatch=0, error attached.
  // Both paths satisfy the result-correctness invariant above.
  assert.equal(metrics.length, 1);
  const m = metrics[0]!;
  assert.equal(m.mismatch, 0);
  assert.ok(m.source === "primary" || m.source === "fallback");
});

test("readAuditLogCutover emits a metric under shadow flag", async () => {
  resetFlags();
  process.env.AUDIT_LOG_ASYNC_READ_ENABLED = "1";
  process.env.AUDIT_LOG_SHADOW_READ_ENABLED = "1";

  const seeded = seedAuditLog();
  const metrics: ReadAuditLogCutoverMetric[] = [];
  const result = await readAuditLogCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  // Shadow on + primary up → 1 primary metric, mismatch reflects compare result.
  // Shadow on + primary throws → 1 fallback metric after primary catch, plus
  //   the mismatch=1 from the shadow-try block (which is now swallowed inside
  //   withReadCutover; only the final primary-catch fallback metric leaks out).
  // Either way at least one metric is emitted.
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});