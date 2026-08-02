import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  setSkillInstallationStatusSync,
  registerDaemonRuntimesSync,
  readTaskSkillExecutionSnapshotSync,
  setSkillRolloutPinSync,
  setStoredEmployeeSkillAssignmentsSync,
} from "@dofe-agent/db";
import {
  assertSkillInstallationReadyForTaskSync,
  buildAndPersistSkillArtifactSync,
  createEmployeeSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  createWorkspaceSkillSync,
  resetWorkspaceStateSync,
  resolveOrLoadTaskSkillExecutionSnapshotSync,
  resolveTaskSkillExecutionSnapshotSync,
  updateWorkspaceSkillSync,
  upsertAgentSkillRequirementsSync,
} from "@dofe-agent/services";
import type { WorkspaceSkill } from "@dofe-agent/domain";
import { collectSkillReadinessBlockers, materializeAgentSkills, resolveAgentSkillEnvironment } from "./task-context.ts";

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

/* ------------------------------------------------------------------ */
/* Task execution snapshot + multi-revision readiness                   */
/* ------------------------------------------------------------------ */

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    workspaceId: WORKSPACE_ID,
    daemonKey: `daemon-${WORKSPACE_ID}`,
    deviceName: "Test Daemon",
    runtimes: [{ provider: "claude", name: "Test Runtime", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}

function insertTaskRow(runtimeId: string, agentName = "Researcher"): string {
  const db = getDatabase();
  const taskId = `task-${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_task_queue (
      id, workspace_id, agent_id, runtime_id, trigger_type, status, input_json, queued_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'manual', 'queued', '{}', ?, ?, ?)`,
  ).run(taskId, WORKSPACE_ID, agentName, runtimeId, now, now, now);
  return taskId;
}

/**
 * Builds an artifact from UNIQUE content (so a fresh digest is produced and the
 * skill's active digest is pinned), installs it on `runtimeId`, and marks it
 * `ready`. Returns the digest + installation id for follow-up assertions.
 */
function buildReadyInstallation(
  skill: { id: string; name: string },
  runtimeId: string,
  name: string,
  content: string,
): { artifactDigest: string; installationId: string; installation: { id: string; revision: string } } {
  const artifact = buildAndPersistSkillArtifactSync({
    workspaceId: WORKSPACE_ID,
    skillId: skill.id,
    name,
    files: [{ path: "SKILL.md", bytes: Buffer.from(`${content}\n${randomBytes(4).toString("hex")}\n`) }],
  });
  const installation = createSkillInstallationPlanSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: artifact.digest,
  });
  setSkillInstallationStatusSync({
    installationId: installation.id,
    workspaceId: WORKSPACE_ID,
    status: "ready",
    health: "healthy",
    verifiedAt: new Date().toISOString(),
  });
  return { artifactDigest: artifact.digest, installationId: installation.id, installation };
}

function resolveSnapshotForTask(taskId: string, runtimeId: string, agentSkills: WorkspaceSkill[]) {
  return resolveOrLoadTaskSkillExecutionSnapshotSync(taskId, {
    workspaceId: WORKSPACE_ID,
    runtimeId,
    agentName: "Researcher",
    agentSkills,
  });
}

function readMaterializedSkillContent(workDir: string): string {
  const compatibilityDir = join(workDir, ".agent_context", "skills");
  const entry = readdirSync(compatibilityDir, { withFileTypes: true }).find((item) => item.isDirectory());
  if (!entry) {
    return "";
  }
  return readFileSync(join(compatibilityDir, entry.name, "SKILL.md"), "utf8");
}

test("assertSkillInstallationReadyForTaskSync resolves the highest ready revision after an upgrade", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({ name: "multi-rev-gate", description: "Upg" }, WORKSPACE_ID);
  const runtimeId = createRuntime();

  const v1 = buildReadyInstallation(skill, runtimeId, "multi-rev-gate", "# Body v1");
  const gateV1 = assertSkillInstallationReadyForTaskSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: v1.artifactDigest,
  });
  assert.equal(gateV1.ok, true);
  if (gateV1.ok) {
    assert.equal(gateV1.revision, "v1");
    assert.equal(gateV1.installationId, v1.installationId);
  }

  // Upgrade to a new digest creates a v2 installation that is still preparing.
  const v2Artifact = buildAndPersistSkillArtifactSync({
    workspaceId: WORKSPACE_ID,
    skillId: skill.id,
    name: "multi-rev-gate",
    files: [{ path: "SKILL.md", bytes: Buffer.from(`# Body v2\n${randomBytes(4).toString("hex")}\n`) }],
  });
  const v2 = createSkillUpgradePlanSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: v2Artifact.digest,
    previousReadyInstallationId: v1.installationId,
  });
  assert.equal(v2.revision, "v2");

  // The gate must find the v2 row and report its real status, not "no installation".
  const gateV2 = assertSkillInstallationReadyForTaskSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: v2Artifact.digest,
  });
  assert.equal(gateV2.ok, false);
  if (!gateV2.ok) {
    assert.equal(gateV2.status, "preparing");
  }

  // Once v2 is ready, the gate resolves it (no longer stuck on the v1 hardcode).
  setSkillInstallationStatusSync({
    installationId: v2.id,
    workspaceId: WORKSPACE_ID,
    status: "ready",
    health: "healthy",
    verifiedAt: new Date().toISOString(),
  });
  const gateV2Ready = assertSkillInstallationReadyForTaskSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: v2Artifact.digest,
  });
  assert.equal(gateV2Ready.ok, true);
  if (gateV2Ready.ok) {
    assert.equal(gateV2Ready.revision, "v2");
    assert.equal(gateV2Ready.installationId, v2.id);
  }
});

test("task skill execution snapshot pins the artifact digest across an upgrade", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({ name: "snapshot-pin", description: "Pin" }, WORKSPACE_ID);
  const runtimeId = createRuntime();
  const taskId = insertTaskRow(runtimeId);

  const v1 = buildReadyInstallation(skill, runtimeId, "snapshot-pin", "# Body v1");

  const snapshot = resolveSnapshotForTask(taskId, runtimeId, [skill]);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]!.artifactDigest, v1.artifactDigest);
  assert.equal(snapshot.entries[0]!.revision, "v1");

  // Upgrade: a new artifact + v2 installation moves the skill's active digest.
  const v2Artifact = buildAndPersistSkillArtifactSync({
    workspaceId: WORKSPACE_ID,
    skillId: skill.id,
    name: "snapshot-pin",
    files: [{ path: "SKILL.md", bytes: Buffer.from(`# Body v2\n${randomBytes(4).toString("hex")}\n`) }],
  });
  createSkillUpgradePlanSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: v2Artifact.digest,
    previousReadyInstallationId: v1.installationId,
  });

  // Same taskId → the persisted snapshot is reused and still pinned to v1.
  const reused = resolveSnapshotForTask(taskId, runtimeId, [skill]);
  assert.equal(reused.entries[0]!.artifactDigest, v1.artifactDigest);
  assert.equal(reused.resolvedAt, snapshot.resolvedAt);

  // Materialization uses the snapshot digest → v1 content, not the upgraded v2.
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-snapshot-pin-"));
  try {
    const digestBySkillId = new Map(snapshot.entries.map((entry) => [entry.skillId, entry.artifactDigest]));
    materializeAgentSkills([skill], workDir, "claude", digestBySkillId, WORKSPACE_ID);
    assert.match(readMaterializedSkillContent(workDir), /# Body v1/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("collectSkillReadinessBlockers fails closed when the pinned installation is rolled back", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({ name: "freshness", description: "F" }, WORKSPACE_ID);
  const runtimeId = createRuntime();
  const taskId = insertTaskRow(runtimeId);
  const v1 = buildReadyInstallation(skill, runtimeId, "freshness", "# Body v1");

  const snapshot = resolveSnapshotForTask(taskId, runtimeId, [skill]);
  assert.deepEqual(
    collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined, undefined, snapshot),
    [],
  );

  // Simulate a rollback: the pinned installation is degraded.
  setSkillInstallationStatusSync({
    installationId: v1.installationId,
    workspaceId: WORKSPACE_ID,
    status: "degraded",
    health: "rolled_back",
  });

  const blockers = collectSkillReadinessBlockers(WORKSPACE_ID, "Researcher", [skill], runtimeId, undefined, undefined, snapshot);
  assert.ok(blockers.some((blocker) => blocker.includes("freshness")), "expected a freshness blocker after rollback");
});

test("task skill execution snapshot persists and round-trips for audit", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({ name: "snapshot-roundtrip", description: "R" }, WORKSPACE_ID);
  const runtimeId = createRuntime();
  const taskId = insertTaskRow(runtimeId);
  const v1 = buildReadyInstallation(skill, runtimeId, "snapshot-roundtrip", "# Body v1");

  const snapshot = resolveSnapshotForTask(taskId, runtimeId, [skill]);
  const persisted = readTaskSkillExecutionSnapshotSync(taskId);
  assert.deepEqual(persisted, snapshot);
  assert.equal(persisted?.entries.length, 1);
  assert.equal(persisted?.entries[0]?.artifactDigest, v1.artifactDigest);
  assert.equal(persisted?.entries[0]?.installationId, v1.installationId);
  assert.equal(persisted?.entries[0]?.revision, "v1");
  assert.equal(persisted?.entries[0]?.releaseLockDigest?.length, 64, "snapshot records the release lock digest");
});

test("rollout_pin fixes new tasks to the pinned installation revision until the rollout switches", () => {
  createEmployeeSync({ name: "Researcher" }, WORKSPACE_ID);
  const skill = createWorkspaceSkillSync({ name: "rollout-pin", description: "Pin" }, WORKSPACE_ID);
  const runtimeId = createRuntime();
  const taskId = insertTaskRow(runtimeId);

  // Two ready installations of the SAME digest at v1 and v2 (re-install bumps
  // the revision while the digest is unchanged) so the pin has a choice.
  const artifact = buildAndPersistSkillArtifactSync({
    workspaceId: WORKSPACE_ID,
    skillId: skill.id,
    name: "rollout-pin",
    files: [{ path: "SKILL.md", bytes: Buffer.from(`# Pin v1\n${randomBytes(4).toString("hex")}\n`) }],
  });
  const v1 = createSkillInstallationPlanSync({ workspaceId: WORKSPACE_ID, runtimeId, artifactDigest: artifact.digest });
  setSkillInstallationStatusSync({ installationId: v1.id, workspaceId: WORKSPACE_ID, status: "ready", health: "healthy" });
  const v2 = createSkillUpgradePlanSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    artifactDigest: artifact.digest,
    previousReadyInstallationId: v1.id,
  });
  setSkillInstallationStatusSync({ installationId: v2.id, workspaceId: WORKSPACE_ID, status: "ready", health: "healthy" });
  assert.equal(v2.revision, "v2");

  // Assign the skill so the assignment row carries the rollout pin.
  setStoredEmployeeSkillAssignmentsSync("Researcher", [skill.id], WORKSPACE_ID);

  // Resolve fresh each time (NOT resolveOrLoad, which freezes the persisted
  // snapshot) so the pin switch is observable.
  const resolveFresh = () => resolveTaskSkillExecutionSnapshotSync({
    workspaceId: WORKSPACE_ID,
    runtimeId,
    agentName: "Researcher",
    agentSkills: [skill],
  });

  // Unpinned → highest ready revision (v2).
  const unpinned = resolveFresh();
  assert.equal(unpinned.entries[0]?.revision, "v2");

  // Pin to v1 → new tasks resolve v1 even though v2 is ready.
  setSkillRolloutPinSync({ workspaceId: WORKSPACE_ID, skillId: skill.id, revision: "v1" });
  const pinnedV1 = resolveFresh();
  assert.equal(pinnedV1.entries[0]?.revision, "v1");
  assert.equal(pinnedV1.entries[0]?.installationId, v1.id);

  // Rollout switch to v2 → new tasks resolve v2.
  setSkillRolloutPinSync({ workspaceId: WORKSPACE_ID, skillId: skill.id, revision: "v2" });
  const pinnedV2 = resolveFresh();
  assert.equal(pinnedV2.entries[0]?.revision, "v2");
  assert.equal(pinnedV2.entries[0]?.installationId, v2.id);
});
