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
  readAgentSkillRequirementEnvSync,
  resetWorkspaceStateSync,
  upsertAgentSkillRequirementsSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skill-requirements-"));
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

function createSkillWithRequirements() {
  return createWorkspaceSkillSync({
    name: "notion-sync",
    description: "Sync to Notion",
    configJson: JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
      ],
    }),
  });
}

test("readAgentSkillRequirementEnvSync returns config values and decrypted secrets", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-token-456" },
  });

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.NOTION_DATABASE_ID, "db-123");
  assert.equal(env.NOTION_API_TOKEN, "secret-token-456");
});

test("readAgentSkillRequirementEnvSync ignores undeclared keys", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123", UNDECLARED_CONFIG: "ignored" },
    secrets: { NOTION_API_TOKEN: "secret-token-456", UNDECLARED_SECRET: "ignored-too" },
  });

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.NOTION_DATABASE_ID, "db-123");
  assert.equal(env.NOTION_API_TOKEN, "secret-token-456");
  assert.equal(env.UNDECLARED_CONFIG, undefined);
  assert.equal(env.UNDECLARED_SECRET, undefined);
});

test("readAgentSkillRequirementEnvSync drops keys starting with DOFE_AGENT_", () => {
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

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.DOFE_AGENT_OVERRIDDEN, undefined);
});

test("readAgentSkillRequirementEnvSync returns empty object when no configuration exists", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.deepEqual(env, {});
});

test("readAgentSkillRequirementEnvSync throws when encryption key is missing and secret is stored", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-token-456" },
  });

  delete process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
  assert.throws(
    () => readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id }),
    /DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY/,
  );
});
