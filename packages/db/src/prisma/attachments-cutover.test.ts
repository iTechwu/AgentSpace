// Unit tests for the attachment pg 原型 cutover runner (Phase 2 12 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listStoredAttachmentsSync } from "../attachments.ts";
import {
  isAttachmentsAsyncReadEnabled,
} from "./attachments-async.ts";
import {
  listStoredAttachmentsCutover,
  type ListAttachmentsCutoverMetric,
} from "./attachments-cutover.ts";

const ORIGINAL_ASYNC = process.env.ATTACHMENTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.ATTACHMENTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.ATTACHMENTS_ASYNC_READ_ENABLED;
  delete process.env.ATTACHMENTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.ATTACHMENTS_ASYNC_READ_ENABLED;
  else process.env.ATTACHMENTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.ATTACHMENTS_SHADOW_READ_ENABLED;
  else process.env.ATTACHMENTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listStoredAttachmentsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isAttachmentsAsyncReadEnabled(), false);
  const metrics: ListAttachmentsCutoverMetric[] = [];
  const result = await listStoredAttachmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listStoredAttachmentsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listStoredAttachmentsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.ATTACHMENTS_ASYNC_READ_ENABLED = "1";
  delete process.env.ATTACHMENTS_SHADOW_READ_ENABLED;

  const metrics: ListAttachmentsCutoverMetric[] = [];
  const result = await listStoredAttachmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listStoredAttachmentsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listStoredAttachmentsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.ATTACHMENTS_ASYNC_READ_ENABLED = "1";
  process.env.ATTACHMENTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListAttachmentsCutoverMetric[] = [];
  const result = await listStoredAttachmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});