import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  archiveWorkspaceNotificationSync,
  countUnreadWorkspaceNotificationsSync,
  createUserSync,
  createWorkspaceNotificationSync,
  createWorkspaceSync,
  listWorkspaceNotificationsForRecipientSync,
  markWorkspaceNotificationReadSync,
} from "./index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-notifications-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("workspace notifications are recipient scoped and track read/archive state", { concurrency: false }, () => {
  const { workspaceId, userId, otherUserId } = seedNotificationWorkspace();

  const notification = createWorkspaceNotificationSync({
    workspaceId,
    recipientType: "human",
    recipientId: userId,
    actorType: "system",
    type: "workspace.member_role_updated",
    resourceType: "workspace_member",
    resourceId: userId,
    title: "Workspace role updated",
    body: "Your role changed.",
    severity: "success",
    metadata: { targetRole: "admin" },
  });

  assert.equal(countUnreadWorkspaceNotificationsSync({
    workspaceId,
    recipientType: "human",
    recipientId: userId,
  }), 1);
  assert.equal(listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "human",
    recipientId: otherUserId,
  }).length, 0);

  const read = markWorkspaceNotificationReadSync({
    workspaceId,
    notificationId: notification.id,
    recipient: { recipientType: "human", recipientId: userId },
  });
  assert.equal(read?.status, "read");
  assertValidTimestamp(read?.readAt);
  assert.equal(countUnreadWorkspaceNotificationsSync({
    workspaceId,
    recipientType: "human",
    recipientId: userId,
  }), 0);

  const archived = archiveWorkspaceNotificationSync({
    workspaceId,
    notificationId: notification.id,
    recipient: { recipientType: "human", recipientId: userId },
  });
  assert.equal(archived?.status, "archived");
  assertValidTimestamp(archived?.archivedAt);
  assert.equal(listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "human",
    recipientId: userId,
  }).length, 0);
  assert.equal(listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "human",
    recipientId: userId,
    includeArchived: true,
  })[0]?.id, notification.id);
});

test("workspace notification dedupe keys update one fact instead of inserting duplicates", { concurrency: false }, () => {
  const { workspaceId, userId } = seedNotificationWorkspace();
  const first = createWorkspaceNotificationSync({
    workspaceId,
    recipientType: "agent",
    recipientId: "Planner",
    actorType: "human",
    actorId: userId,
    type: "document.agent_access_granted",
    resourceType: "document",
    resourceId: "doc-1",
    channelName: "research",
    title: "Document access granted",
    body: "Planner can view the document.",
    dedupeKey: "document.agent_access_granted:doc-1:Planner",
  });
  const second = createWorkspaceNotificationSync({
    workspaceId,
    recipientType: "agent",
    recipientId: "Planner",
    actorType: "human",
    actorId: userId,
    type: "document.agent_access_granted",
    resourceType: "document",
    resourceId: "doc-1",
    channelName: "research",
    title: "Document access granted",
    body: "Planner can edit the document.",
    severity: "success",
    dedupeKey: "document.agent_access_granted:doc-1:Planner",
    metadata: { role: "editor" },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.body, "Planner can edit the document.");
  assert.equal(second.severity, "success");
  assert.deepEqual(listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "agent",
    recipientId: "Planner",
  }).map((notification) => notification.id), [first.id]);
});

function seedNotificationWorkspace(): {
  workspaceId: string;
  userId: string;
  otherUserId: string;
} {
  const workspace = createWorkspaceSync({
    slug: `notifications-${Math.random().toString(36).slice(2)}`,
    name: "Notifications",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-${Math.random().toString(36).slice(2)}@example.com`,
  });
  const otherUser = createUserSync({
    displayName: "Alex",
    primaryEmail: `alex-${Math.random().toString(36).slice(2)}@example.com`,
  });
  return {
    workspaceId: workspace.id,
    userId: user.id,
    otherUserId: otherUser.id,
  };
}

function assertValidTimestamp(value: string | undefined): void {
  assert.equal(typeof value, "string");
  assert.equal(Number.isNaN(Date.parse(value ?? "")), false);
}
