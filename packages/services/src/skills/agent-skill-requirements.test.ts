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
  listEmployeeSkillIdsSync,
  readAgentSkillRequirementEnvSync,
  readAgentSkillRequirementConfigurationSync,
  readAgentSkillRequirementSummarySync,
  resetWorkspaceStateSync,
  setEmployeeSkillIdsSync,
  upsertAgentSkillRequirementsSync,
  deleteAgentSkillRequirementKeySync,
  resolveSkillProjectWorkDirSync,
  updateWorkspaceSkillSync,
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

function createSkillWithConfig(name: string, key: string) {
  return createWorkspaceSkillSync({
    name,
    description: "Test config",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: key }],
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

  const encryptionKey = process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
  try {
    delete process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
    assert.throws(
      () => readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id }),
      /DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY/,
    );
  } finally {
    process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY = encryptionKey;
  }
});

test("upsertAgentSkillRequirementsSync rejects a conflicting installed skill before saving", () => {
  createEmployeeSync({ name: "Researcher" });
  const installedSkill = createSkillWithConfig("installed-skill", "SHARED_KEY");
  const candidateSkill = createSkillWithConfig("candidate-skill", "SHARED_KEY");
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: installedSkill.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "existing-value" },
  });
  setEmployeeSkillIdsSync("Researcher", [installedSkill.id]);

  assert.throws(
    () => upsertAgentSkillRequirementsSync({
      workspaceId: "default",
      employeeName: "Researcher",
      skillId: candidateSkill.id,
      actorUserId: TEST_USER_ID,
      values: { SHARED_KEY: "different-value" },
    }),
    /SHARED_KEY.*installed-skill/,
  );
  assert.equal(
    readAgentSkillRequirementConfigurationSync({
      workspaceId: "default",
      employeeName: "Researcher",
      skillId: candidateSkill.id,
    }).configuration,
    undefined,
  );
});

test("upsertAgentSkillRequirementsSync accepts the same value used by an installed skill", () => {
  createEmployeeSync({ name: "Researcher" });
  const installedSkill = createSkillWithConfig("installed-skill", "SHARED_KEY");
  const candidateSkill = createSkillWithConfig("candidate-skill", "SHARED_KEY");
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: installedSkill.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "shared-value" },
  });
  setEmployeeSkillIdsSync("Researcher", [installedSkill.id]);

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: candidateSkill.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "shared-value" },
  });

  assert.equal(
    readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: candidateSkill.id }).SHARED_KEY,
    "shared-value",
  );
});

test("upsertAgentSkillRequirementsSync can save and assign the skill atomically", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithConfig("atomic-install", "INSTALL_KEY");

  const skillIds = upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { INSTALL_KEY: "configured" },
    assignSkill: true,
  });

  assert.deepEqual(skillIds, [skill.id]);
  assert.deepEqual(listEmployeeSkillIdsSync("Researcher"), [skill.id]);
});

test("upsertAgentSkillRequirementsSync preserves an existing secret when it is not replaced", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-before" },
    secrets: { NOTION_API_TOKEN: "secret-before" },
  });

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-after" },
    secrets: {},
  });

  assert.deepEqual(readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id }), {
    NOTION_DATABASE_ID: "db-after",
    NOTION_API_TOKEN: "secret-before",
  });
});

test("upsertAgentSkillRequirementsSync rejects managed runtime credential keys", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "managed-credential-conflict",
    description: "Conflict",
    configJson: JSON.stringify({
      requirements: [{ kind: "secret", value: "OPENAI_API_KEY" }],
    }),
  });

  assert.throws(
    () => upsertAgentSkillRequirementsSync({
      workspaceId: "default",
      employeeName: "Researcher",
      skillId: skill.id,
      actorUserId: TEST_USER_ID,
      secrets: { OPENAI_API_KEY: "skill-key" },
      managedRuntimeCredentialKey: "OPENAI_API_KEY",
    }),
    /OPENAI_API_KEY is managed by the bound runtime/,
  );
});

test("upsertAgentSkillRequirementsSync rejects runtime-incompatible configuration before saving", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "codex-only",
    description: "Codex only",
    configJson: JSON.stringify({
      requirements: [{ kind: "provider", value: "codex" }],
    }),
  });

  assert.throws(
    () => upsertAgentSkillRequirementsSync({
      workspaceId: "default",
      employeeName: "Researcher",
      skillId: skill.id,
      actorUserId: TEST_USER_ID,
      modelProvider: "codex",
      runtimeProvider: "claude",
    }),
    /bound runtime uses claude/,
  );
  assert.equal(
    readAgentSkillRequirementConfigurationSync({
      workspaceId: "default",
      employeeName: "Researcher",
      skillId: skill.id,
    }).configuration,
    undefined,
  );
});

test("readAgentSkillRequirementSummarySync reports missing requirements", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });

  assert.equal(summary.status, "needs_configuration");
  assert.equal(summary.configuredCount, 0);
  assert.equal(summary.requiredCount, 2);
  assert.deepEqual(summary.environment, [
    { key: "NOTION_DATABASE_ID", kind: "config", sensitive: false, configured: false },
    { key: "NOTION_API_TOKEN", kind: "secret", sensitive: true, configured: false },
  ]);
});

test("readAgentSkillRequirementSummarySync exposes metadata without secret values", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-never-returned" },
  });

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });

  assert.equal(summary.status, "ready");
  assert.equal(summary.configuredCount, 2);
  assert.equal(summary.configuration?.values.NOTION_DATABASE_ID, "db-123");
  assert.equal(JSON.stringify(summary).includes("secret-never-returned"), false);
});

test("readAgentSkillRequirementSummarySync reports expired after a requirement upgrade", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-token" },
  });

  // Simulate a reimport that adds a new required config key.
  getDatabase().prepare("UPDATE skill SET config_json = ? WHERE id = ?").run(
    JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
        { kind: "config", value: "NOTION_PAGE_SIZE" },
      ],
    }),
    skill.id,
  );

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });
  assert.equal(summary.status, "expired");
  assert.deepEqual(summary.upgradeAddedKeys, ["NOTION_PAGE_SIZE"]);
});

test("readAgentSkillRequirementSummarySync clears expired after the upgrade is re-saved", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-token" },
  });
  getDatabase().prepare("UPDATE skill SET config_json = ? WHERE id = ?").run(
    JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
        { kind: "config", value: "NOTION_PAGE_SIZE" },
      ],
    }),
    skill.id,
  );
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123", NOTION_PAGE_SIZE: "10" },
    secrets: { NOTION_API_TOKEN: "secret-token" },
  });

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });
  assert.equal(summary.status, "ready");
  assert.deepEqual(summary.upgradeAddedKeys, []);
});

test("readAgentSkillRequirementSummarySync reports awaiting validation when the runtime is offline", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-123" },
    secrets: { NOTION_API_TOKEN: "secret-token" },
  });

  const offline = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    runtimeOnline: false,
  });
  assert.equal(offline.status, "awaiting_validation");

  const online = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    runtimeOnline: true,
  });
  assert.equal(online.status, "ready");
});

test("sensitive config values are encrypted, kept out of plaintext, and decrypt at runtime", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "webhook-skill",
    description: "Webhook",
    configJson: JSON.stringify({ requirements: [{ kind: "config", value: "WEBHOOK_URL" }] }),
  });

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { WEBHOOK_URL: "https://example.com/hook/secret" },
    sensitiveKeys: ["WEBHOOK_URL"],
  });

  const stored = readAgentSkillRequirementConfigurationSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });
  assert.equal(stored.configuration?.values.WEBHOOK_URL, undefined);
  assert.ok(stored.configuredSecretKeys.includes("WEBHOOK_URL"));
  assert.ok(stored.configuration?.sensitiveKeys.includes("WEBHOOK_URL"));

  const row = getDatabase()
    .prepare(`SELECT config_json AS c, encrypted_secrets_json AS e FROM agent_skill_requirement_config WHERE skill_id = ?`)
    .get(skill.id) as { c: string; e: string };
  assert.ok(!row.c.includes("https://example.com/hook/secret"));
  assert.ok(row.e.includes("WEBHOOK_URL"));
  assert.ok(!row.e.includes("https://example.com/hook/secret"));

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.WEBHOOK_URL, "https://example.com/hook/secret");

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });
  assert.equal(summary.status, "ready");
  const item = summary.environment.find((entry) => entry.key === "WEBHOOK_URL");
  assert.equal(item?.sensitive, true);
  assert.equal(item?.configured, true);
});

test("sensitive config value is retained when re-saved without a new value", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "webhook-skill",
    description: "Webhook",
    configJson: JSON.stringify({ requirements: [{ kind: "config", value: "WEBHOOK_URL" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { WEBHOOK_URL: "https://example.com/hook/secret" },
    sensitiveKeys: ["WEBHOOK_URL"],
  });

  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { WEBHOOK_URL: "" },
    sensitiveKeys: ["WEBHOOK_URL"],
  });

  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.WEBHOOK_URL, "https://example.com/hook/secret");
});

test("deleteAgentSkillRequirementKeySync removes a config value and recomputes status", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "config-skill",
    description: "Config",
    configJson: JSON.stringify({ requirements: [{ kind: "config", value: "REGION" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { REGION: "us-east-1" },
  });
  assert.equal(
    readAgentSkillRequirementSummarySync({ workspaceId: "default", employeeName: "Researcher", skillId: skill.id }).status,
    "ready",
  );

  const removed = deleteAgentSkillRequirementKeySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    key: "REGION",
    actorUserId: TEST_USER_ID,
  });
  assert.equal(removed.kind, "config");

  const after = readAgentSkillRequirementSummarySync({ workspaceId: "default", employeeName: "Researcher", skillId: skill.id });
  assert.equal(after.status, "needs_configuration");
  assert.equal(after.environment[0]?.configured, false);
});

test("deleteAgentSkillRequirementKeySync removes an encrypted secret and recomputes status", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "secret-skill",
    description: "Secret",
    configJson: JSON.stringify({ requirements: [{ kind: "secret", value: "API_TOKEN" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    secrets: { API_TOKEN: "token-value-abc" },
  });
  assert.equal(
    readAgentSkillRequirementSummarySync({ workspaceId: "default", employeeName: "Researcher", skillId: skill.id }).status,
    "ready",
  );

  const removed = deleteAgentSkillRequirementKeySync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
    key: "API_TOKEN",
    actorUserId: TEST_USER_ID,
  });
  assert.equal(removed.kind, "secret");
  assert.equal(removed.sensitive, true);

  const stored = readAgentSkillRequirementConfigurationSync({
    workspaceId: "default",
    employeeName: "Researcher",
    skillId: skill.id,
  });
  assert.ok(!stored.configuredSecretKeys.includes("API_TOKEN"));
  const env = readAgentSkillRequirementEnvSync({ employeeName: "Researcher", skillId: skill.id });
  assert.equal(env.API_TOKEN, undefined);
});

test("summary exposes a stable queryable statusDetail code per status", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createSkillWithRequirements();
  // unconfigured → needs_configuration
  let summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id,
  });
  assert.equal(summary.statusDetail.code, "skill_needs_configuration");

  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-1" }, secrets: { NOTION_API_TOKEN: "tok" },
  });
  summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, runtimeOnline: true,
  });
  assert.equal(summary.status, "ready");
  assert.equal(summary.statusDetail.code, "skill_ready");

  summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, runtimeOnline: false,
  });
  assert.equal(summary.statusDetail.code, "skill_awaiting_validation");
});

test("summary surfaces historically-stored reserved DOFE_AGENT_ declarations as invalid", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "legacy-skill",
    description: "Legacy",
    configJson: JSON.stringify({
      requirements: [
        { kind: "config", value: "DOFE_AGENT_LEGACY" },
        { kind: "config", value: "HEALTHY_CONFIG" },
      ],
    }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    values: { HEALTHY_CONFIG: "ok" },
  });
  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id,
  });
  // Reserved key is dropped from active requirements but surfaced as invalid.
  assert.ok(summary.invalidDeclarations?.includes("config:DOFE_AGENT_LEGACY"));
  assert.ok(!summary.environment.some((entry) => entry.key === "DOFE_AGENT_LEGACY"));
});

test("resolveSkillProjectWorkDirSync returns the unanimous project dir and undefined on conflict", () => {
  createEmployeeSync({ name: "Researcher" });
  const skillA = createWorkspaceSkillSync({
    name: "proj-a",
    description: "Project A",
    configJson: JSON.stringify({ requirements: [{ kind: "project", value: "repo" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skillA.id, actorUserId: TEST_USER_ID,
    projectWorkDir: "/workspace/proj-a",
  });
  setEmployeeSkillIdsSync("Researcher", [skillA.id]);
  assert.equal(resolveSkillProjectWorkDirSync("default", "Researcher"), "/workspace/proj-a");

  // Second project skill with a different dir → no unanimous consensus.
  const skillB = createWorkspaceSkillSync({
    name: "proj-b",
    description: "Project B",
    configJson: JSON.stringify({ requirements: [{ kind: "project", value: "repo" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skillB.id, actorUserId: TEST_USER_ID,
    projectWorkDir: "/workspace/proj-b",
  });
  setEmployeeSkillIdsSync("Researcher", [skillA.id, skillB.id]);
  assert.equal(resolveSkillProjectWorkDirSync("default", "Researcher"), undefined);
});

test("summary reports both added and removed keys after a requirement upgrade", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "evolving",
    description: "Evolving",
    configJson: JSON.stringify({ requirements: [
      { kind: "config", value: "KEEP_KEY" },
      { kind: "config", value: "DROP_KEY" },
    ] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    values: { KEEP_KEY: "v1", DROP_KEY: "v2" },
  });
  // Upgrade: drop DROP_KEY, add NEW_KEY.
  updateWorkspaceSkillSync({ skillId: skill.id, configJson: JSON.stringify({ requirements: [
    { kind: "config", value: "KEEP_KEY" },
    { kind: "config", value: "NEW_KEY" },
  ] }) });

  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id,
  });
  assert.equal(summary.status, "expired");
  assert.deepEqual(summary.upgradeAddedKeys, ["NEW_KEY"]);
  assert.deepEqual(summary.upgradeRemovedKeys, ["DROP_KEY"]);
});

test("summary warns when a declared key collides with a managed runtime credential key", () => {
  createEmployeeSync({ name: "Researcher" });
  const skill = createWorkspaceSkillSync({
    name: "openai-skill",
    description: "OpenAI",
    configJson: JSON.stringify({ requirements: [{ kind: "secret", value: "OPENAI_API_KEY" }] }),
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    secrets: { OPENAI_API_KEY: "sk-value" },
  });
  const summary = readAgentSkillRequirementSummarySync({
    workspaceId: "default", employeeName: "Researcher", skillId: skill.id,
  });
  assert.ok(summary.credentialKeyWarnings?.includes("OPENAI_API_KEY"));
});
