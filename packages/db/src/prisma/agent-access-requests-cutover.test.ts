// Unit tests for the agent-access-request pg 原型 cutover runner
// (Phase 2 11 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listAgentAccessRequestsSync } from "../agent-access-requests.ts";
import {
  isAgentAccessRequestsAsyncReadEnabled,
} from "./agent-access-requests-async.ts";
import {
  listAgentAccessRequestsCutover,
  type ListAgentAccessRequestsCutoverMetric,
} from "./agent-access-requests-cutover.ts";

const ORIGINAL_ASYNC = process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
  delete process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
  else process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED;
  else process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listAgentAccessRequestsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isAgentAccessRequestsAsyncReadEnabled(), false);
  const metrics: ListAgentAccessRequestsCutoverMetric[] = [];
  const result = await listAgentAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listAgentAccessRequestsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listAgentAccessRequestsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED = "1";
  delete process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED;

  const metrics: ListAgentAccessRequestsCutoverMetric[] = [];
  const result = await listAgentAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listAgentAccessRequestsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listAgentAccessRequestsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED = "1";
  process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListAgentAccessRequestsCutoverMetric[] = [];
  const result = await listAgentAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});