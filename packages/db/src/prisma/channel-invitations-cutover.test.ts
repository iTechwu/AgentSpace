// Unit tests for the channel-invitation pg 原型 cutover runner
// (Phase 2 17 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listChannelInvitationsSync } from "../channel-access.ts";
import {
  isChannelInvitationsAsyncReadEnabled,
} from "./channel-invitations-async.ts";
import {
  listChannelInvitationsCutover,
  type ListChannelInvitationsCutoverMetric,
} from "./channel-invitations-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED;
  delete process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED;
  else process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listChannelInvitationsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isChannelInvitationsAsyncReadEnabled(), false);
  const metrics: ListChannelInvitationsCutoverMetric[] = [];
  const result = await listChannelInvitationsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listChannelInvitationsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listChannelInvitationsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED = "1";
  delete process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED;

  const metrics: ListChannelInvitationsCutoverMetric[] = [];
  const result = await listChannelInvitationsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listChannelInvitationsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listChannelInvitationsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED = "1";
  process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED = "1";

  const metrics: ListChannelInvitationsCutoverMetric[] = [];
  const result = await listChannelInvitationsCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});