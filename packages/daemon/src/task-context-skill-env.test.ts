import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import {
  createEmployeeSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
  upsertAgentSkillRequirementsSync,
} from "@dofe-agent/services";
import { collectSkillReadinessBlockers, resolveAgentSkillEnvironment } from "./task-context.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-task-context-skill-env-"));
const originalEncryptionKey = process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
const TEST_USER_ID = "user-1";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
  process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(() => {
  resetWorkspaceStateSync();
  const db = getDatabase();
  db.exec("DELETE FROM users");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
     VALUES (?, 'Test User', 'test@example.com', 1, ?, ?)`,
  ).run(TEST_USER_ID, now, now);
});

after(() => {
  process.chdir(originalCwd);
  if (originalEncryptionKey === undefined) {
    delete process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
  }
});

function createSkillWithConfig(name: string, key: string) {
  return createWorkspaceSkillSync({
    name,
    description: "Test",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: key }],
    }),
  });
}

test("resolveAgentSkillEnvironment merges env from multiple skills", () => {
  createEmployeeSync({ name: "Researcher" });
  const skillA = createSkillWithConfig("skill-a", "KEY_A");
  const skillB = createSkillWithConfig("skill-b", "KEY_B");

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skillA.id,
    actorUserId: TEST_USER_ID,
    values: { KEY_A: "value-a" },
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skillB.id,
    actorUserId: TEST_USER_ID,
    values: { KEY_B: "value-b" },
  });

  const { env, conflicts } = resolveAgentSkillEnvironment("default", "Researcher", [skillA, skillB]);
  assert.deepEqual(env, { KEY_A: "value-a", KEY_B: "value-b" });
  assert.deepEqual(conflicts, []);
});

test("resolveAgentSkillEnvironment detects conflicts for same key with different values", () => {
  createEmployeeSync({ name: "Researcher" });
  const skillA = createSkillWithConfig("skill-a", "SHARED_KEY");
  const skillB = createSkillWithConfig("skill-b", "SHARED_KEY");

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skillA.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "value-a" },
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skillB.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "value-b" },
  });

  const { env, conflicts } = resolveAgentSkillEnvironment("default", "Researcher", [skillA, skillB]);
  assert.equal(env.SHARED_KEY, "value-a");
  assert.deepEqual(conflicts, ["SHARED_KEY"]);
});

test("resolveAgentSkillEnvironment ignores DOFE_AGENT_ prefixed keys", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "bad-prefix-skill",
    description: "Bad",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: "DOFE_AGENT_OVERRIDDEN" }],
    }),
  });

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { DOFE_AGENT_OVERRIDDEN: "bad-value" },
  });

  const { env } = resolveAgentSkillEnvironment("default", "Researcher", [skill]);
  assert.equal(env.DOFE_AGENT_OVERRIDDEN, undefined);
});

test("collectSkillReadinessBlockers reports missing required configuration and clears once configured", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "notion-sync",
    description: "Sync",
    configJson: JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
      ],
    }),
  });

  let blockers = collectSkillReadinessBlockers("default", "Researcher", [skill], undefined);
  assert.ok(blockers.length >= 2, "expected missing-config and missing-secret blockers");
  assert.ok(blockers.some((b) => b.includes("NOTION_DATABASE_ID")));
  assert.ok(blockers.some((b) => b.includes("NOTION_API_TOKEN")));

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-1" },
    secrets: { NOTION_API_TOKEN: "tok" },
  });

  blockers = collectSkillReadinessBlockers("default", "Researcher", [skill], undefined);
  assert.deepEqual(blockers, []);
});
