import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  createUserSync,
  createWorkspaceSync,
} from "@dofe-agent/db";
import {
  archiveNotificationSync,
  countUnreadNotificationsSync,
  createNotificationSync,
  listNotificationsForRecipientSync,
  markNotificationReadSync,
  postNotificationChannelMessageSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-notification-service-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test("notification service lists, reads, and archives recipient-scoped notifications", { concurrency: false }, () => {
  const workspace = createWorkspaceSync({
    slug: `notification-service-${Math.random().toString(36).slice(2)}`,
    name: "Notification Service",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-${Math.random().toString(36).slice(2)}@example.com`,
  });

  const notification = createNotificationSync({
    workspaceId: workspace.id,
    recipientType: "human",
    recipientId: user.id,
    actorType: "system",
    type: "runtime.use_granted",
    resourceType: "runtime",
    resourceId: "runtime-1",
    title: "Runtime access granted",
    body: "You can use runtime-1.",
    severity: "success",
    dedupeKey: `runtime.use_granted:${workspace.id}:runtime-1:${user.id}`,
  });

  assert.equal(countUnreadNotificationsSync({
    workspaceId: workspace.id,
    recipientType: "human",
    recipientId: user.id,
  }), 1);
  assert.equal(listNotificationsForRecipientSync({
    workspaceId: workspace.id,
    recipientType: "human",
    recipientId: user.id,
  })[0]?.id, notification.id);

  assert.equal(markNotificationReadSync({
    workspaceId: workspace.id,
    notificationId: notification.id,
    recipient: { recipientType: "human", recipientId: user.id },
  })?.status, "read");
  assert.equal(archiveNotificationSync({
    workspaceId: workspace.id,
    notificationId: notification.id,
    recipient: { recipientType: "human", recipientId: user.id },
  })?.status, "archived");
  assert.equal(listNotificationsForRecipientSync({
    workspaceId: workspace.id,
    recipientType: "human",
    recipientId: user.id,
  }).length, 0);
});

test("notification channel messages post to group channels and skip direct channels", { concurrency: false }, () => {
  const workspace = createWorkspaceSync({
    slug: `notification-channel-${Math.random().toString(36).slice(2)}`,
    name: "Notification Channel",
    createdBy: "system",
  });
  const state = resetWorkspaceStateSync(workspace.id);
  writeWorkspaceStateSync({
    ...state,
    channels: [
      {
        name: "research",
        kind: "group",
        humanMemberNames: ["Mina"],
        humanMembers: 1,
        employeeNames: ["Planner"],
      },
      {
        name: "direct-planner",
        kind: "direct",
        humanMemberNames: ["Mina"],
        humanMembers: 1,
        employeeNames: ["Planner"],
      },
    ],
  }, workspace.id);

  assert.equal(postNotificationChannelMessageSync({
    workspaceId: workspace.id,
    channelName: "research",
    summary: "Planner received document access.",
    code: "document.agent_access_granted_notice",
    data: {
      document_id: "doc-1",
    },
  }), true);
  assert.equal(postNotificationChannelMessageSync({
    workspaceId: workspace.id,
    channelName: "direct-planner",
    summary: "Private access changed.",
    code: "document.agent_access_granted_notice",
  }), false);

  const messages = readWorkspaceStateSync(workspace.id).messages;
  assert.equal(messages.filter((message) => message.code === "document.agent_access_granted_notice").length, 1);
  assert.equal(messages[0]?.channel, "research");
  assert.equal(messages[0]?.status, "completed");
});
