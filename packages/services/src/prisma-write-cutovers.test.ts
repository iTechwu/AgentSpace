// Services 级 Prisma 写 cutover 集成测试：与 prisma-read-cutovers.test.ts 同款
// 真 DB 夹具，但写 flag 全开——async 变体走真 Prisma Client 主路径（非 mock），
// 覆盖 notifications create/markRead/archive/notifyAdmins、document grant/revoke、
// skill-draft upsert/delete 五个已接线的生产写面。

import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredWorkspaceSkillSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceNotificationSync,
  createWorkspaceSync,
  disconnectDofePrismaClient,
  hardDeleteWorkspaceSync,
  listDocumentAgentAccessSync,
  listWorkspaceNotificationsForRecipientSync,
} from "@dofe-agent/db";
import {
  archiveNotificationAsync,
  createChannelDocumentSync,
  createChannelSync,
  createEmployeeSync,
  discardSkillDraftAsync,
  grantDocumentAgentAccessAsync,
  markNotificationReadAsync,
  notifyWorkspaceAdminsAsync,
  readSkillDraftSync,
  revokeDocumentAgentAccessAsync,
  saveSkillDraftAsync,
} from "./index.ts";

const WRITE_FLAGS = [
  "NOTIFICATIONS_PRISMA_WRITE_ENABLED",
  "DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED",
  "SKILL_DRAFTS_PRISMA_WRITE_ENABLED",
] as const;
const ORIGINAL_FLAGS = WRITE_FLAGS.map((flag) => process.env[flag]);

test.before(() => {
  for (const flag of WRITE_FLAGS) process.env[flag] = "1";
});

test.after(async () => {
  WRITE_FLAGS.forEach((flag, index) => {
    if (ORIGINAL_FLAGS[index] === undefined) delete process.env[flag];
    else process.env[flag] = ORIGINAL_FLAGS[index]!;
  });
  await disconnectDofePrismaClient();
});

interface SeededContext {
  workspaceId: string;
  admin: { id: string; displayName: string };
  secondAdmin: { id: string; displayName: string };
}

function seedWorkspace(suffix: string): SeededContext {
  const workspaceId = `workspace-write-cutover-${suffix}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Write Cutover ${suffix}`,
    createdBy: "write-cutover-test",
  });
  const admin = createUserSync({
    displayName: `Admin ${suffix}`,
    primaryEmail: `admin-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: admin.id, role: "admin" });
  const secondAdmin = createUserSync({
    displayName: `Owner ${suffix}`,
    primaryEmail: `owner-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: secondAdmin.id, role: "owner" });
  return { workspaceId, admin, secondAdmin };
}

test("Prisma write services land rows through the real Prisma primary path", { concurrency: false }, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { workspaceId, admin, secondAdmin } = seedWorkspace(suffix);
  try {
    // --- notifications: create (sync fixture) -> markRead -> archive ---
    const created = createWorkspaceNotificationSync({
      workspaceId,
      recipientType: "human",
      recipientId: admin.id,
      actorType: "system",
      actorId: "system",
      type: "test.write_cutover",
      title: "Write cutover",
      body: "flag-on integration",
      severity: "info",
      resourceType: "workspace",
    });
    const readUpdated = await markNotificationReadAsync({
      workspaceId,
      notificationId: created.id,
      recipient: { recipientType: "human", recipientId: admin.id },
    });
    assert.ok(readUpdated, "markReadAsync should return the updated row");
    assert.equal(readUpdated.status, "read");
    const archived = await archiveNotificationAsync({
      workspaceId,
      notificationId: created.id,
      recipient: { recipientType: "human", recipientId: admin.id },
    });
    assert.ok(archived, "archiveAsync should return the updated row");
    assert.equal(archived.status, "archived");

    // --- notifyWorkspaceAdminsAsync: per-admin rows + dedupe collapse ---
    const notifyInput = {
      workspaceId,
      title: "演练告警",
      body: "write cutover admin fanout",
      type: "data_protection",
      severity: "critical" as const,
      dedupeKey: `write-cutover-${suffix}`,
    };
    const first = await notifyWorkspaceAdminsAsync(notifyInput);
    assert.equal(first.length, 2, "both admins should be notified");
    await notifyWorkspaceAdminsAsync(notifyInput);
    for (const member of [admin, secondAdmin]) {
      const rows = listWorkspaceNotificationsForRecipientSync({
        workspaceId,
        recipientType: "human",
        recipientId: member.id,
      });
      const deduped = rows.filter((row) => row.type === "data_protection");
      assert.equal(deduped.length, 1, "repeat notify should dedupe per recipient");
    }

    // --- document grant -> revoke ---
    createEmployeeSync({ name: "CutoverAgent" }, workspaceId);
    createChannelSync({ name: "general", employeeNames: ["CutoverAgent"] }, workspaceId);
    const { document } = createChannelDocumentSync({
      channelName: "general",
      title: "Write cutover doc",
      kind: "markdown",
      storageMode: "workspace",
      contentMarkdown: "# cutover",
      createdBy: "CutoverAgent",
      createdByType: "agent",
    }, workspaceId);
    const grant = await grantDocumentAgentAccessAsync({
      workspaceId,
      documentId: document.id,
      agentName: "CutoverAgent",
      role: "editor",
      grantedByUserId: admin.id,
    });
    assert.equal(grant.role, "editor");
    assert.equal(grant.subjectId, "CutoverAgent");
    const listed = listDocumentAgentAccessSync({ workspaceId, documentId: document.id });
    assert.equal(listed.some((row) => row.id === grant.id && !row.revokedAt), true);
    const revoked = await revokeDocumentAgentAccessAsync({
      workspaceId,
      documentId: document.id,
      agentName: "CutoverAgent",
    });
    assert.ok(revoked, "revokeAsync should return the revoked row");
    assert.ok(revoked.revokedAt, "revokeAsync should stamp revokedAt");

    // --- skill draft: deterministic skill fixture (FK target), upsert -> delete ---
    const now = new Date().toISOString();
    const skillId = `skill-write-cutover-${suffix}`;
    createStoredWorkspaceSkillSync({
      id: skillId,
      name: "Cutover Skill",
      description: "write cutover fixture",
      files: [],
      createdAt: now,
      updatedAt: now,
    }, workspaceId);
    const saved = await saveSkillDraftAsync({
      workspaceId,
      skillId,
      name: "Cutover draft",
      description: "flag-on",
      files: [{ path: "SKILL.md", content: "# cutover" }],
      actorUserId: admin.id,
    });
    assert.equal(saved.name, "Cutover draft");
    const readBack = readSkillDraftSync({ workspaceId, skillId });
    assert.ok(readBack, "draft should be readable via the sync path after Prisma upsert");
    assert.equal(
      await discardSkillDraftAsync({ workspaceId, skillId }),
      true,
      "discardAsync should remove the row",
    );
    assert.equal(readSkillDraftSync({ workspaceId, skillId }), null);
  } finally {
    hardDeleteWorkspaceSync(workspaceId);
  }
});
