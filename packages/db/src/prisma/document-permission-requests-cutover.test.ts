// Unit tests for the document-permission-request pg 原型 cutover runner
// (Phase 2 10 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listDocumentPermissionRequestsSync } from "../document-agent-access.ts";
import {
  isDocumentPermissionRequestsAsyncReadEnabled,
} from "./document-permission-requests-async.ts";
import {
  listDocumentPermissionRequestsCutover,
  type ListDocumentPermissionRequestsCutoverMetric,
} from "./document-permission-requests-cutover.ts";

const ORIGINAL_ASYNC = process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED;
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED;
  else process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED;
  else process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listDocumentPermissionRequestsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isDocumentPermissionRequestsAsyncReadEnabled(), false);
  const metrics: ListDocumentPermissionRequestsCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listDocumentPermissionRequestsSync());
  assert.equal(metrics.length, 0);
});

test("listDocumentPermissionRequestsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED = "1";
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED;

  const metrics: ListDocumentPermissionRequestsCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listDocumentPermissionRequestsSync().map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listDocumentPermissionRequestsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED = "1";
  process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListDocumentPermissionRequestsCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});