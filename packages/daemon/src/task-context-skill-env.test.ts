import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, setSkillInstallationStatusSync, registerDaemonRuntimesSync } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  createEmployeeSync,
  createSkillInstallationPlanSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
  updateWorkspaceSkillSync,
  upsertAgentSkillRequirementsSync,
} from "@dofe-agent/services";
import { collectSkillReadinessBlockers, resolveAgentSkillEnvironment } from "./task-context.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-task-context-skill-env-"));
const originalEncryptionKey = process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
const TEST_USER_ID = "user-1";
// Dedicated workspace so this file does not collide with other skill test files
// (e.g. packages/services/.../agent-skill-requirements.test.ts) when both run concurrently
// against the shared test database. resetWorkspaceStateSync is workspace-scoped.
const WORKSPACE_ID = "daemon-skill-env-test";

before(() => {
  process.env.NODE_ENV = "test";
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
  process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
});

after(() => {
  process.chdir(originalCwd);
  if (originalEncryptionKey === undefined) {
    delete process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
  }
});

function prepareSkillInstallationForTaskGate(
  skill: { id: string; name: string; files: Array<{ path: string; content: string }> },
  workspaceId = WORKSPACE_ID,
): string {
  const snapshot = registerDaemonRuntimesSync({
    workspaceId,
    daemonKey: `daemon-${workspaceId}`,
    deviceName: "Test Daemon",
    runtimes: [{ provider: "claude", name: "Test Runtime", version: "test" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  const artifact = buildAndPersistSkillArtifactSync({
    workspaceId,
    skillId: skill.id,
    name: skill.name,
    files: skill.files.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.content),
    })),
  });
  const installation = createSkillInstallationPlanSync({
    workspaceId,
    runtimeId,
    artifactDigest: artifact.digest,
  });
  setSkillInstallationStatusSync({
    installationId: installation.id,
    workspaceId,
    status: "ready",
    health: "healthy",
    verifiedAt: new Date().toISOString(),
  });
  return runtimeId;
}

function createSkillWithConfig(name: string, key: string) {
  return createWorkspaceSkillSync({
    name,
    description: "Test",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: key }],
    }),
  }, WORKSPACE_ID);
}

test("resolveAgentSkillEnvironment merges env from multiple skills", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skillA = createSkillWithConfig("skill-a", "KEY_A");
  const skillB = createSkillWithConfig("skill-b", "KEY_B");

  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skillA.id,
    actorUserId: TEST_USER_ID,
    values: { KEY_A: "value-a" },
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skillB.id,
    actorUserId: TEST_USER_ID,
    values: { KEY_B: "value-b" },
  });

  const { env, conflicts } = resolveAgentSkillEnvironment(WORKSPACE_ID, "Researcher", [skillA, skillB]);
  assert.deepEqual(env, { KEY_A: "value-a", KEY_B: "value-b" });
  assert.deepEqual(conflicts, []);
});

test("resolveAgentSkillEnvironment detects conflicts for same key with different values", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skillA = createSkillWithConfig("skill-a", "SHARED_KEY");
  const skillB = createSkillWithConfig("skill-b", "SHARED_KEY");

  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skillA.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "value-a" },
  });
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skillB.id,
    actorUserId: TEST_USER_ID,
    values: { SHARED_KEY: "value-b" },
  });

  const { env, conflicts } = resolveAgentSkillEnvironment(WORKSPACE_ID, "Researcher", [skillA, skillB]);
  assert.equal(env.SHARED_KEY, "value-a");
  assert.deepEqual(conflicts, ["SHARED_KEY"]);
});

test("resolveAgentSkillEnvironment ignores DOFE_AGENT_ prefixed keys", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "bad-prefix-skill",
    description: "Bad",
    configJson: JSON.stringify({
      requirements: [{ kind: "config", value: "DOFE_AGENT_OVERRIDDEN" }],
    }),
  }, WORKSPACE_ID);

  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { DOFE_AGENT_OVERRIDDEN: "bad-value" },
  });

  const { env } = resolveAgentSkillEnvironment(WORKSPACE_ID, "Researcher", [skill]);
  assert.equal(env.DOFE_AGENT_OVERRIDDEN, undefined);
});

test("collectSkillReadinessBlockers reports missing required configuration and clears once configured", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "notion-sync",
    description: "Sync",
    configJson: JSON.stringify({
      requirements: [
        { kind: "config", value: "NOTION_DATABASE_ID" },
        { kind: "secret", value: "NOTION_API_TOKEN" },
      ],
    }),
  }, WORKSPACE_ID);
  const runtimeId = prepareSkillInstallationForTaskGate(skill);

  let blockers = collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined);
  assert.ok(blockers.length >= 2, "expected missing-config and missing-secret blockers");
  assert.ok(blockers.some((b) => b.includes("NOTION_DATABASE_ID")));
  assert.ok(blockers.some((b) => b.includes("NOTION_API_TOKEN")));

  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID,
    employeeName: "Researcher",
    skillId: skill.id,
    actorUserId: TEST_USER_ID,
    values: { NOTION_DATABASE_ID: "db-1" },
    secrets: { NOTION_API_TOKEN: "tok" },
  });

  blockers = collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined);
  assert.deepEqual(blockers, []);
});

test("collectSkillReadinessBlockers flags a missing runtime capability when a capability catalog is supplied", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "needs-tool",
    description: "Tool",
    configJson: JSON.stringify({ requirements: [{ kind: "capability", value: "ffmpeg" }] }),
  }, WORKSPACE_ID);
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID, employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    capabilities: ["ffmpeg"],
  });
  const runtimeId = prepareSkillInstallationForTaskGate(skill);

  // No catalog supplied → legacy behavior (capabilities are form-confirmed only).
  assert.deepEqual(collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined), []);
  // Catalog supplied but missing the capability → blocker.
  const blocked = collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined, ["git", "gh"]);
  assert.ok(blocked.some((b) => b.includes("ffmpeg") && b.includes("does not support capability")));
  // Catalog includes it → no blocker.
  assert.deepEqual(collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined, ["ffmpeg"]), []);
});

test("collectSkillReadinessBlockers surfaces a missing requirement after a skill requirement upgrade", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({
    name: "upgradable",
    description: "Upg",
    configJson: JSON.stringify({ requirements: [{ kind: "config", value: "FIRST_KEY" }] }),
  }, WORKSPACE_ID);
  upsertAgentSkillRequirementsSync({
    workspaceId: WORKSPACE_ID, employeeName: "Researcher", skillId: skill.id, actorUserId: TEST_USER_ID,
    values: { FIRST_KEY: "v1" },
  });
  const runtimeId = prepareSkillInstallationForTaskGate(skill);
  assert.deepEqual(collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined), []);

  // Simulate a skill update that adds a new required key.
  updateWorkspaceSkillSync({ skillId: skill.id, configJson: JSON.stringify({ requirements: [
    { kind: "config", value: "FIRST_KEY" },
    { kind: "config", value: "SECOND_KEY" },
  ] }) }, WORKSPACE_ID);

  const blockers = collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined);
  assert.ok(blockers.some((b) => b.includes("SECOND_KEY")), "expected the newly-required key to block the task");
});
