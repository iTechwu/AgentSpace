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
  mapAsyncNotificationRow,
  normalizeNotificationsLimit,
} from "./notifications-async.ts";
import {
  createListWorkspaceNotificationsCutover,
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

test("async notification rows preserve the workspace notification domain contract", () => {
  const record = mapAsyncNotificationRow({
    id: "notification-contract",
    workspace_id: "workspace-contract",
    recipient_type: "agent",
    recipient_id: "agent-contract",
    actor_type: "system",
    actor_id: "system-contract",
    type: "capability.request.completed",
    resource_type: "capability_request",
    resource_id: "request-contract",
    channel_name: null,
    title: "Capability ready",
    body: "The requested capability is ready.",
    action_href: "/market",
    severity: "critical",
    status: "unread",
    dedupe_key: "request-contract:completed",
    metadata_json: { requestId: "request-contract" },
    created_at: new Date("2026-08-15T00:00:00.000Z"),
    read_at: null,
    archived_at: null,
  });

  assert.deepEqual(record, {
    id: "notification-contract",
    workspaceId: "workspace-contract",
    recipientType: "agent",
    recipientId: "agent-contract",
    actorType: "system",
    actorId: "system-contract",
    type: "capability.request.completed",
    resourceType: "capability_request",
    resourceId: "request-contract",
    title: "Capability ready",
    body: "The requested capability is ready.",
    actionHref: "/market",
    severity: "critical",
    status: "unread",
    dedupeKey: "request-contract:completed",
    metadataJson: '{"requestId":"request-contract"}',
    createdAt: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(normalizeNotificationsLimit(undefined), 100);
  assert.equal(normalizeNotificationsLimit(19.6), 20);
});

test("notifications cutover deterministically exercises primary, shadow, and fallback", async () => {
  const fallbackRecord = createWorkspaceNotificationSync({
    workspaceId: "default",
    recipientType: "human",
    recipientId: "cutover-injected",
    type: "cutover.injected",
    resourceType: "task",
    title: "fallback",
    body: "fallback",
  });
  const primaryRecord = { ...fallbackRecord, title: "primary" };
  const metrics: ListNotificationsCutoverMetric[] = [];
  let fallbackCalls = 0;
  const read = createListWorkspaceNotificationsCutover({
    isEnabled: () => true,
    isShadowEnabled: () => true,
    runPrimary: async () => [primaryRecord],
    runFallback: () => {
      fallbackCalls += 1;
      return [fallbackRecord];
    },
  });

  const result = await read(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: "cutover-injected",
    },
    (metric) => metrics.push(metric),
  );

  assert.deepEqual(result, [primaryRecord]);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(metrics.map(({ source, mismatch }) => ({ source, mismatch })), [
    { source: "primary", mismatch: 1 },
  ]);

  const fallbackMetrics: ListNotificationsCutoverMetric[] = [];
  const readWithFailure = createListWorkspaceNotificationsCutover({
    isEnabled: () => true,
    isShadowEnabled: () => false,
    runPrimary: async () => {
      throw new Error("primary unavailable");
    },
    runFallback: () => [fallbackRecord],
  });
  const fallbackResult = await readWithFailure(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: "cutover-injected",
    },
    (metric) => fallbackMetrics.push(metric),
  );
  assert.deepEqual(fallbackResult, [fallbackRecord]);
  assert.equal(fallbackMetrics[0]?.source, "fallback");
  // Caller-side metrics are sanitized via combineMetricSinks: error content
  // is replaced with the sentinel "present" to avoid leaking connection
  // details through telemetry. The actual error message still lives in the
  // cutover-runner internal metric path.
  assert.equal(fallbackMetrics[0]?.error, "present");
});
