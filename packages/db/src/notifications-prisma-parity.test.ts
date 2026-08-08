// Phase 2 parity test — workspace_notification async Prisma repo vs legacy sync.
//
// Same fixture (seeded into agent_space_test) → `*Sync` and `*Async` must agree.
// Read/list/count paths compare DTOs (or counts) directly, locking the
// timestamptz→ISO / jsonb→string / nullable→undefined fidelity rules. Write paths
// (create / createMany) strip the volatile id; state-effect paths (markRead /
// archive) seed two equivalent rows, apply sync to one and async to the other,
// then deep-equal the resulting reads. See prisma/runtime-mappers.ts for rules.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  archiveWorkspaceNotificationAsync,
  archiveWorkspaceNotificationSync,
  countUnreadWorkspaceNotificationsAsync,
  countUnreadWorkspaceNotificationsSync,
  createWorkspaceNotificationAsync,
  createWorkspaceNotificationSync,
  createWorkspaceNotificationsAsync,
  createWorkspaceNotificationsSync,
  listWorkspaceNotificationsForRecipientAsync,
  listWorkspaceNotificationsForRecipientSync,
  markWorkspaceNotificationReadAsync,
  markWorkspaceNotificationReadSync,
  type CreateWorkspaceNotificationInput,
} from "./notifications.ts";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import { assertParityEqual, parityTest } from "./prisma/parity-test-harness.ts";
import { shutdownPrisma } from "./prisma/client.ts";

const WORKSPACE = "wn-parity-ws";
const RECIPIENT = { recipientType: "human" as const, recipientId: "wn-u1" };

function seedWorkspace(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, `slug-${id}`, `WN Parity ${id}`);
}

function seedNotification(
  id: string,
  type: string,
  severity: string,
  createdAt: string,
  dedupeKey: string | null,
  metadataJson = "{}",
  title?: string,
  body?: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace_notification (
         id, workspace_id, recipient_type, recipient_id, actor_type, actor_id, type,
         resource_type, resource_id, channel_name, title, body, action_href, severity,
         status, dedupe_key, metadata_json, created_at, read_at, archived_at
       ) VALUES (?, ?, 'human', 'wn-u1', 'system', 'actor-1', ?, 'task', 'res-1', NULL, ?, ?, NULL, ?, 'unread', ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, severity = EXCLUDED.severity`,
    )
    .run(id, WORKSPACE, type, title ?? `title-${id}`, body ?? `body-${id}`, severity, dedupeKey, metadataJson, createdAt);
}

function deleteNotification(id: string): void {
  getDatabase().prepare("DELETE FROM workspace_notification WHERE id = ?").run(id);
}

before(() => {
  resetDatabaseForTests();
  seedWorkspace(WORKSPACE);
  // Distinct created_at so ORDER BY created_at DESC is deterministic (n3 → n2 → n1).
  seedNotification("wn-parity-1", "mention", "info", "2026-08-09T10:00:00.000Z", null, JSON.stringify({ tag: "a" }));
  seedNotification("wn-parity-2", "task_assigned", "warning", "2026-08-09T11:00:00.000Z", "dedupe-n2");
  seedNotification("wn-parity-3", "task_assigned", "critical", "2026-08-09T12:00:00.000Z", "dedupe-n3");
});

after(async () => {
  getDatabase().prepare("DELETE FROM workspace_notification WHERE workspace_id = ?").run(WORKSPACE);
  getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(WORKSPACE);
  await shutdownPrisma();
  resetDatabaseForTests();
});

parityTest("listWorkspaceNotificationsForRecipient (status filter, ordered DESC)", {
  sync: () =>
    listWorkspaceNotificationsForRecipientSync({ workspaceId: WORKSPACE, ...RECIPIENT, status: ["unread"] }),
  async: () =>
    listWorkspaceNotificationsForRecipientAsync({ workspaceId: WORKSPACE, ...RECIPIENT, status: ["unread"] }),
});

parityTest("countUnreadWorkspaceNotifications", {
  sync: () => countUnreadWorkspaceNotificationsSync({ workspaceId: WORKSPACE, ...RECIPIENT }),
  async: () => countUnreadWorkspaceNotificationsAsync({ workspaceId: WORKSPACE, ...RECIPIENT }),
});

// Write parity: createdAt is pinned via input (deterministic); only id (randomLikeId)
// differs. Create the same payload sequentially (delete between), strip id.
test("[parity] createWorkspaceNotification write (id stripped, createdAt pinned)", async () => {
  const base: CreateWorkspaceNotificationInput = {
    workspaceId: WORKSPACE,
    ...RECIPIENT,
    type: "parity_create",
    resourceType: "task",
    resourceId: "res-create",
    title: "parity-create-title",
    body: "parity-create-body",
    severity: "warning",
    metadata: { count: 7, nested: { ok: true } },
    createdAt: "2026-08-09T13:00:00.000Z",
  };
  try {
    const syncRec = createWorkspaceNotificationSync({ ...base });
    deleteNotification(syncRec.id);
    const asyncRec = await createWorkspaceNotificationAsync({ ...base });
    const { id: _sId, ...syncRest } = syncRec;
    const { id: _aId, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "createWorkspaceNotification async diverged from sync");
  } finally {
    // Clean any row tagged by this case (resourceId is unique per case).
    getDatabase()
      .prepare("DELETE FROM workspace_notification WHERE workspace_id = ? AND resource_id = 'res-create'")
      .run(WORKSPACE);
  }
});

// Dedupe-upsert write parity: same dedupeKey, sequential (delete between). Confirms
// the partial-unique ON CONFLICT path is byte-identical between sync and async.
test("[parity] createWorkspaceNotification dedupe upsert (id stripped)", async () => {
  const base: CreateWorkspaceNotificationInput = {
    workspaceId: WORKSPACE,
    ...RECIPIENT,
    type: "parity_dedupe",
    resourceType: "task",
    resourceId: "res-dedupe",
    title: "parity-dedupe-title",
    body: "parity-dedupe-body",
    severity: "info",
    dedupeKey: "dedupe-parity-case",
    createdAt: "2026-08-09T14:00:00.000Z",
  };
  try {
    const syncRec = createWorkspaceNotificationSync({ ...base });
    getDatabase()
      .prepare("DELETE FROM workspace_notification WHERE workspace_id = ? AND dedupe_key = 'dedupe-parity-case'")
      .run(WORKSPACE);
    const asyncRec = await createWorkspaceNotificationAsync({ ...base });
    const { id: _sId, ...syncRest } = syncRec;
    const { id: _aId, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "createWorkspaceNotification dedupe async diverged from sync");
  } finally {
    getDatabase()
      .prepare("DELETE FROM workspace_notification WHERE workspace_id = ? AND dedupe_key = 'dedupe-parity-case'")
      .run(WORKSPACE);
  }
});

test("[parity] createWorkspaceNotifications batch (ids stripped)", async () => {
  const inputs: CreateWorkspaceNotificationInput[] = [
    {
      workspaceId: WORKSPACE, ...RECIPIENT, type: "parity_batch", resourceType: "task",
      resourceId: "res-batch-1", title: "b1", body: "b1", severity: "info", createdAt: "2026-08-09T15:00:00.000Z",
    },
    {
      workspaceId: WORKSPACE, ...RECIPIENT, type: "parity_batch", resourceType: "task",
      resourceId: "res-batch-2", title: "b2", body: "b2", severity: "critical", createdAt: "2026-08-09T15:01:00.000Z",
    },
  ];
  try {
    const syncRecs = createWorkspaceNotificationsSync(inputs.map((i) => ({ ...i })));
    for (const r of syncRecs) deleteNotification(r.id);
    const asyncRecs = await createWorkspaceNotificationsAsync(inputs.map((i) => ({ ...i })));
    assert.equal(asyncRecs.length, syncRecs.length);
    for (let i = 0; i < syncRecs.length; i += 1) {
      const { id: _sId, ...syncRest } = syncRecs[i]!;
      const { id: _aId, ...asyncRest } = asyncRecs[i]!;
      assertParityEqual(syncRest, asyncRest, `createWorkspaceNotifications[${i}] diverged`);
    }
  } finally {
    getDatabase()
      .prepare("DELETE FROM workspace_notification WHERE workspace_id = ? AND resource_id IN ('res-batch-1','res-batch-2')")
      .run(WORKSPACE);
  }
});

// State-effect parity: seed two equivalent unread rows, mark one sync and one
// async, deep-equal the reads (strip volatile id + readAt).
test("[parity] markWorkspaceNotificationRead state effect", async () => {
  seedNotification("wn-parity-mark-sync", "parity_mark", "info", "2026-08-09T16:00:00.000Z", null, "{}", "parity-mark-title", "parity-mark-body");
  seedNotification("wn-parity-mark-async", "parity_mark", "info", "2026-08-09T16:00:00.000Z", null, "{}", "parity-mark-title", "parity-mark-body");
  try {
    const syncRec = markWorkspaceNotificationReadSync({
      workspaceId: WORKSPACE, notificationId: "wn-parity-mark-sync", recipient: RECIPIENT,
    });
    const asyncRec = await markWorkspaceNotificationReadAsync({
      workspaceId: WORKSPACE, notificationId: "wn-parity-mark-async", recipient: RECIPIENT,
    });
    assert.ok(syncRec && asyncRec, "both marked");
    assert.equal(syncRec.status, "read");
    assert.equal(asyncRec.status, "read");
    assert.equal(typeof asyncRec.readAt, "string", "readAt must be ISO string, not Date");
    const { id: _s, readAt: _sr, ...syncRest } = syncRec;
    const { id: _a, readAt: _ar, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "markWorkspaceNotificationRead diverged");
  } finally {
    deleteNotification("wn-parity-mark-sync");
    deleteNotification("wn-parity-mark-async");
  }
});

test("[parity] archiveWorkspaceNotification state effect", async () => {
  seedNotification("wn-parity-arch-sync", "parity_arch", "warning", "2026-08-09T17:00:00.000Z", null, "{}", "parity-arch-title", "parity-arch-body");
  seedNotification("wn-parity-arch-async", "parity_arch", "warning", "2026-08-09T17:00:00.000Z", null, "{}", "parity-arch-title", "parity-arch-body");
  try {
    const syncRec = archiveWorkspaceNotificationSync({
      workspaceId: WORKSPACE, notificationId: "wn-parity-arch-sync", recipient: RECIPIENT,
    });
    const asyncRec = await archiveWorkspaceNotificationAsync({
      workspaceId: WORKSPACE, notificationId: "wn-parity-arch-async", recipient: RECIPIENT,
    });
    assert.ok(syncRec && asyncRec, "both archived");
    assert.equal(syncRec.status, "archived");
    assert.equal(asyncRec.status, "archived");
    assert.equal(typeof asyncRec.archivedAt, "string", "archivedAt must be ISO string, not Date");
    const { id: _s, archivedAt: _sa, ...syncRest } = syncRec;
    const { id: _a, archivedAt: _aa, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "archiveWorkspaceNotification diverged");
  } finally {
    deleteNotification("wn-parity-arch-sync");
    deleteNotification("wn-parity-arch-async");
  }
});
