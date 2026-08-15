// Unit tests for the knowledge-proposals pg 原型 cutover runner
// (Phase 2 8 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listKnowledgeProposalsSync } from "../knowledge-proposals.ts";
import {
  isKnowledgeProposalsAsyncReadEnabled,
} from "./knowledge-proposals-async.ts";
import {
  listKnowledgeProposalsCutover,
  type ListKnowledgeProposalsCutoverMetric,
} from "./knowledge-proposals-cutover.ts";

const ORIGINAL_ASYNC = process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED;
  delete process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED;
  else process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED;
  else process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listKnowledgeProposalsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isKnowledgeProposalsAsyncReadEnabled(), false);
  const metrics: ListKnowledgeProposalsCutoverMetric[] = [];
  const result = await listKnowledgeProposalsCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listKnowledgeProposalsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listKnowledgeProposalsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED = "1";
  delete process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED;

  const metrics: ListKnowledgeProposalsCutoverMetric[] = [];
  const result = await listKnowledgeProposalsCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listKnowledgeProposalsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listKnowledgeProposalsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED = "1";
  process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED = "1";

  const metrics: ListKnowledgeProposalsCutoverMetric[] = [];
  const result = await listKnowledgeProposalsCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});