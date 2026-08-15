// Unit tests for the channel-access-request pg 原型 cutover runner
// (Phase 2 16 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listChannelAccessRequestsSync } from "../channel-access.ts";
import {
  isChannelAccessRequestsAsyncReadEnabled,
} from "./channel-access-requests-async.ts";
import {
  listChannelAccessRequestsCutover,
  type ListChannelAccessRequestsCutoverMetric,
} from "./channel-access-requests-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
  delete process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED;
  else process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listChannelAccessRequestsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isChannelAccessRequestsAsyncReadEnabled(), false);
  const metrics: ListChannelAccessRequestsCutoverMetric[] = [];
  const result = await listChannelAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listChannelAccessRequestsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listChannelAccessRequestsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED = "1";
  delete process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED;

  const metrics: ListChannelAccessRequestsCutoverMetric[] = [];
  const result = await listChannelAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listChannelAccessRequestsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listChannelAccessRequestsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED = "1";
  process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListChannelAccessRequestsCutoverMetric[] = [];
  const result = await listChannelAccessRequestsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});