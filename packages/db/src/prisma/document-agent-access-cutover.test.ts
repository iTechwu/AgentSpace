// Unit tests for the document-agent-access pg 原型 cutover runner
// (Phase 2 9 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listDocumentAgentAccessSync } from "../document-agent-access.ts";
import {
  isDocumentAgentAccessAsyncReadEnabled,
} from "./document-agent-access-async.ts";
import {
  listDocumentAgentAccessCutover,
  type ListDocumentAgentAccessCutoverMetric,
} from "./document-agent-access-cutover.ts";

const ORIGINAL_ASYNC = process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED;
  delete process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED;
  else process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED;
  else process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listDocumentAgentAccessCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isDocumentAgentAccessAsyncReadEnabled(), false);
  const metrics: ListDocumentAgentAccessCutoverMetric[] = [];
  const result = await listDocumentAgentAccessCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listDocumentAgentAccessSync());
  assert.equal(metrics.length, 0);
});

test("listDocumentAgentAccessCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED = "1";
  delete process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED;

  const metrics: ListDocumentAgentAccessCutoverMetric[] = [];
  const result = await listDocumentAgentAccessCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listDocumentAgentAccessSync().map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listDocumentAgentAccessCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED = "1";
  process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED = "1";

  const metrics: ListDocumentAgentAccessCutoverMetric[] = [];
  const result = await listDocumentAgentAccessCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});