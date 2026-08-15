// Unit tests for the channel-participant pg 原型 cutover runner
// (Phase 2 15 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listChannelParticipantsSync } from "../channel-access.ts";
import {
  isChannelParticipantsAsyncReadEnabled,
} from "./channel-participants-async.ts";
import {
  listChannelParticipantsCutover,
  type ListChannelParticipantsCutoverMetric,
} from "./channel-participants-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED;
  delete process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED;
  else process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listChannelParticipantsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isChannelParticipantsAsyncReadEnabled(), false);
  const metrics: ListChannelParticipantsCutoverMetric[] = [];
  const result = await listChannelParticipantsCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(
    result,
    listChannelParticipantsSync("default", "general"),
  );
  assert.equal(metrics.length, 0);
});

test("listChannelParticipantsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED = "1";
  delete process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED;

  const metrics: ListChannelParticipantsCutoverMetric[] = [];
  const result = await listChannelParticipantsCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(
    listChannelParticipantsSync("default", "general").map((r) => `${r.userId}`),
  );
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.userId));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listChannelParticipantsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED = "1";
  process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED = "1";

  const metrics: ListChannelParticipantsCutoverMetric[] = [];
  const result = await listChannelParticipantsCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});