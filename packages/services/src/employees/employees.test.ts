import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import {
  registerDaemonRuntimesSync,
  updateAgentRuntimeManagedFieldsSync,
} from "@dofe-agent/db";
import {
  bindEmployeeRuntimeSync,
  createEmployeeSync,
  createWorkspaceSkillSync,
  initializeOrganizationSync,
  resetWorkspaceStateSync,
  setEmployeeSkillIdsSync,
  upsertAgentSkillRequirementsSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-employees-"));
const TEST_USER_ID = "user-1";
const WORKSPACE_ID = "employees-test";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync(WORKSPACE_ID);
  const db = getDatabase();
  db.exec("DELETE FROM users");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
     VALUES (?, 'Test User', 'test@example.com', 1, ?, ?)`,
  ).run(TEST_USER_ID, now, now);
  initializeOrganizationSync({
    organizationName: "Test Org",
    ownerName: "techwu",
    ownerRole: "Founder",
  }, WORKSPACE_ID);
});

after(() => {
  process.chdir(originalCwd);
});

function createManagedRuntime(provider: "claude" | "codex") {
  const snapshot = registerDaemonRuntimesSync({
    workspaceId: WORKSPACE_ID,
    daemonKey: `${provider}-managed-box`,
    deviceName: `${provider} Managed Box`,
    runtimes: [{ provider, name: `${provider} Managed`, version: "test" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  updateAgentRuntimeManagedFieldsSync({
    runtimeId,
    managedCredentialId: `${provider}-credential-1`,
    provisioningState: "managed",
    status: "online",
  });
  return runtimeId;
}

test("bindEmployeeRuntimeSync rejects binding a managed runtime whose credential key is declared by an assigned skill", () => {
  process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
  const runtimeId = createManagedRuntime("claude");
  const skill = createWorkspaceSkillSync({
    name: "anthropic-skill",
    description: "Declares ANTHROPIC_API_KEY",
    configJson: JSON.stringify({
      requirements: [{ kind: "secret", value: "ANTHROPIC_API_KEY" }],
    }),
  }, WORKSPACE_ID);

  createEmployeeSync({ name: "Atlas", role: "Planner" }, WORKSPACE_ID);
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Atlas",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    secrets: { ANTHROPIC_API_KEY: "sk-secret" },
    assignSkill: true,
  });

  assert.throws(
    () => bindEmployeeRuntimeSync("Atlas", runtimeId, WORKSPACE_ID, TEST_USER_ID),
    /runtime\.credential_key_conflict:ANTHROPIC_API_KEY:skill:anthropic-skill/,
  );
});

test("bindEmployeeRuntimeSync allows binding a managed runtime when no skill declares its credential key", () => {
  process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
  const runtimeId = createManagedRuntime("claude");
  const skill = createWorkspaceSkillSync({
    name: "generic-skill",
    description: "No credential collision",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: "SOME_OTHER_KEY" }],
    }),
  }, WORKSPACE_ID);

  createEmployeeSync({ name: "Atlas", role: "Planner" }, WORKSPACE_ID);
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Atlas",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { SOME_OTHER_KEY: "value" },
    assignSkill: true,
  });

  const state = bindEmployeeRuntimeSync("Atlas", runtimeId, WORKSPACE_ID, TEST_USER_ID);
  assert.ok(state);
});

test("bindEmployeeRuntimeSync ignores unconfigured declarations when checking credential key collisions", () => {
  process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
  const runtimeId = createManagedRuntime("codex");
  const skill = createWorkspaceSkillSync({
    name: "openai-skill",
    description: "Declares OPENAI_API_KEY but not configured",
    configJson: JSON.stringify({
      requirements: [{ kind: "secret", value: "OPENAI_API_KEY" }],
    }),
  }, WORKSPACE_ID);

  createEmployeeSync({ name: "Nova", role: "Planner" }, WORKSPACE_ID);
  // Assign the skill without configuring the secret.
  setEmployeeSkillIdsSync("Nova", [skill.id], WORKSPACE_ID);

  // Even though the secret is not configured, the declaration itself collides
  // with the managed runtime credential key, so binding should be rejected.
  assert.throws(
    () => bindEmployeeRuntimeSync("Nova", runtimeId, WORKSPACE_ID, TEST_USER_ID),
    /runtime\.credential_key_conflict:OPENAI_API_KEY:skill:openai-skill/,
  );
});
