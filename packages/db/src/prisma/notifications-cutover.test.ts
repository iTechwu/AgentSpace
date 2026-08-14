// Unit tests for the workspace-notifications list cutover runner.
//
// Tests cover:
//   - Flag OFF: short-circuits to sync list, no metric emitted.
//   - Flag ON (shadow off): cutover returns primary or fallback result; both
//     paths must surface the seeded row.
//   - Flag ON + shadow ON: at least one metric emitted.
//
// Each test resets the env at entry to prevent node:test from leaking flag
// state between tests in the same file.

import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceNotificationSync,
  listWorkspaceNotificationsForRecipientSync,
} from "../notifications.ts";
import {
  isNotificationsAsyncReadEnabled,
  isNotificationsShadowReadEnabled,
} from "./notifications-async.ts";
import {
  listWorkspaceNotificationsCutover,
  type ListNotificationsCutoverMetric,
} from "./notifications-cutover.ts";

const ORIGINAL_ASYNC = process.env.NOTIFICATIONS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.NOTIFICATIONS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.NOTIFICATIONS_ASYNC_READ_ENABLED;
  delete process.env.NOTIFICATIONS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.NOTIFICATIONS_ASYNC_READ_ENABLED;
  else process.env.NOTIFICATIONS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.NOTIFICATIONS_SHADOW_READ_ENABLED;
  else process.env.NOTIFICATIONS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

function seedNotifications(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const record = createWorkspaceNotificationSync({
      workspaceId: "default",
      recipientType: "human",
      recipientId: `cutover-recipient-${i}`,
      type: "cutover.test.seed",
      resourceType: "task",
      title: `cutover seed ${i}`,
      body: `seeded for cutover test ${i}`,
      severity: "info",
      metadata: { marker: "fresh", index: i },
    });
    ids.push(record.id);
  }
  return ids;
}

test("listWorkspaceNotificationsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isNotificationsAsyncReadEnabled(), false);
  seedNotifications();
  const metrics: ListNotificationsCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: "cutover-recipient-0",
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  // Flag off → withReadCutover short-circuits to fallback, no metric emitted.
  assert.equal(metrics.length, 0);
});

test("listWorkspaceNotificationsCutover returns correct rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_ASYNC_READ_ENABLED = "1";
  delete process.env.NOTIFICATIONS_SHADOW_READ_ENABLED;

  seedNotifications();
  const metrics: ListNotificationsCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: "cutover-recipient-1",
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  const syncResult = listWorkspaceNotificationsForRecipientSync({
    workspaceId: "default",
    recipientType: "human",
    recipientId: "cutover-recipient-1",
  });
  // The two paths must agree on at least the row count and the top row id
  // (whichever path served the request — primary or fallback — must have
  // surfaced the seeded row).
  assert.equal(result.length, syncResult.length);
  if (result.length > 0 && syncResult.length > 0) {
    assert.equal(result[0]!.id, syncResult[0]!.id);
  }
  // One metric: primary-up → primary metric; primary-down → fallback metric.
  // Both must carry mismatch=0.
  assert.equal(metrics.length, 1);
  const m = metrics[0]!;
  assert.equal(m.mismatch, 0);
  assert.ok(m.source === "primary" || m.source === "fallback");
});

test("listWorkspaceNotificationsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_ASYNC_READ_ENABLED = "1";
  process.env.NOTIFICATIONS_SHADOW_READ_ENABLED = "1";

  seedNotifications();
  const metrics: ListNotificationsCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: "cutover-recipient-0",
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  // Shadow on → at least one metric emitted; durationMs is a number.
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});