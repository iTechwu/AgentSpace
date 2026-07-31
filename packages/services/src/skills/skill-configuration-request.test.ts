import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listWorkspaceNotificationsForRecipientSync,
} from "@dofe-agent/db";
import {
  createEmployeeSync,
  createWorkspaceSkillSync,
  readWorkspaceStateSync,
  requestSkillRequirementConfigurationSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-configuration-request-"));
const originalCwd = process.cwd();

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = originalCwd;
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM workspace_notification;
    DELETE FROM audit_log;
    DELETE FROM agent_skill_requirement_config;
    DELETE FROM workspace_employee;
    DELETE FROM workspace_snapshot;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

function seedHandOffWorkspace() {
  const admin = createUserSync({ displayName: "Admin", primaryEmail: "admin@example.com" });
  const requester = createUserSync({ displayName: "Mina", primaryEmail: "mina@example.com" });
  const workspace = createWorkspaceSync({
    id: `skill-config-request-${Math.random().toString(36).slice(2)}`,
    slug: `skill-config-request-${Math.random().toString(36).slice(2)}`,
    name: "Skill Config Request",
    createdBy: admin.id,
  });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: requester.id, role: "member" });
  const state = resetWorkspaceStateSync(workspace.id);
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      { name: admin.displayName, role: "Admin" },
      { name: requester.displayName, role: "Member" },
    ],
  }, workspace.id);
  createEmployeeSync({ name: "Researcher", role: "Research Agent" }, workspace.id);
  const skill = createWorkspaceSkillSync({
    name: "notion-sync",
    description: "Sync to Notion",
    configJson: JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
      ],
    }),
  }, workspace.id);
  return { workspaceId: workspace.id, admin, requester, skillId: skill.id };
}

test("configuration request notifies admins and records an audit trail with key names only", () => {
  const { workspaceId, admin, requester, skillId } = seedHandOffWorkspace();

  const result = requestSkillRequirementConfigurationSync({
    workspaceId,
    employeeName: "Researcher",
    skillId,
    requesterUserId: requester.id,
  });
  assert.equal(result.keyCount, 2);
  assert.equal(result.adminCount, 1);

  const notifications = listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "human",
    recipientId: admin.id,
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "agent.skill_configuration_requested");
  assert.equal(notifications[0]?.metadataJson.includes("NOTION_DATABASE_ID"), false);

  // The workspace audit ledger records key names + counts (never values).
  const ledger = readWorkspaceStateSync(workspaceId).ledger as Array<{
    code?: string;
    data?: Record<string, unknown>;
  }>;
  const entry = ledger.find((item) => item.code === "workspace.agent_skill_configuration_requested");
  assert.ok(entry, "expected a configuration-request audit entry");
  const data = entry?.data ?? {};
  assert.equal(data.skillName, "notion-sync");
  assert.ok(String(data.keys).includes("NOTION_DATABASE_ID"));
  assert.ok(String(data.keys).includes("NOTION_API_TOKEN"));
  assert.equal(data.keyCount, "2");
});

test("configuration request excludes the requester from admin recipients", () => {
  const { workspaceId, admin, requester, skillId } = seedHandOffWorkspace();
  // The requester is also granted an admin role, but must not receive their own request.
  getDatabase().prepare(
    `UPDATE workspace_membership SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`,
  ).run(workspaceId, requester.id);

  requestSkillRequirementConfigurationSync({
    workspaceId,
    employeeName: "Researcher",
    skillId,
    requesterUserId: requester.id,
  });

  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId,
      recipientType: "human",
      recipientId: admin.id,
    }).length,
    1,
  );
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId,
      recipientType: "human",
      recipientId: requester.id,
    }).length,
    0,
  );
});

test("configuration request throws for an unknown skill", () => {
  const { workspaceId, requester } = seedHandOffWorkspace();
  assert.throws(
    () => requestSkillRequirementConfigurationSync({
      workspaceId,
      employeeName: "Researcher",
      skillId: "does-not-exist",
      requesterUserId: requester.id,
    }),
    /Skill does not exist/,
  );
});
