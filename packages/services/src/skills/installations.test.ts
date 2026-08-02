import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { randomLikeId } from "@dofe-agent/db";
import {
  claimNextSkillInstallationOperationForRuntimeSync,
  listSkillInstallationOperationsSync,
  readActiveArtifactDigestForSkillSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationSync,
} from "@dofe-agent/db";
import {
  assertSkillInstallationReadyForTaskSync,
  buildAndPersistSkillArtifactSync,
  completeSkillInstallationOperationSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  createWorkspaceSkillSync,
  failSkillInstallationOperationSync,
  resolveClaimedSkillInstallationOperation,
  resetWorkspaceStateSync,
  rollbackSkillInstallationSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testTosStorage = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  testTosStorage.clear();
});

after(() => {
  testTosStorage.clear();
});

/** Each test gets its own runtime so the (workspace, runtime, artifact, revision) lock differs. */
function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

const ARTIFACT_FILES = [
  {
    path: "SKILL.md",
    bytes: encoder.encode("---\nname: Install Test\ndescription: gate\ndependencies:\n  - npm:left-pad@1.3.0\n---\n# Body\n"),
  },
  { path: "scripts/render.py", bytes: encoder.encode("print('render')\n"), mode: "0755" },
];

function buildArtifact(skillId?: string) {
  return buildAndPersistSkillArtifactSync({
    skillId,
    name: "Install Test",
    files: ARTIFACT_FILES,
    sourceType: "local",
    dependencies: [{ manager: "npm", name: "left-pad", version: "1.3.0" }],
  });
}

test("createSkillInstallationPlanSync builds installation, components, and a queued operation", () => {
  const runtimeId = createTestRuntime();
  const { artifact, digest } = buildArtifact();

  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });

  assert.equal(installation.artifactDigest, artifact.digest);
  assert.equal(installation.status, "preparing");

  const components = readSkillInstallationComponentsSync(installation.id);
  // npm:left-pad@1.3.0 dependency + scripts/render.py script.
  assert.ok(components.some((c) => c.kind === "dependency" && c.key === "npm:left-pad@1.3.0"));
  assert.ok(components.some((c) => c.kind === "script" && c.key === "scripts/render.py"));

  const operations = listSkillInstallationOperationsSync({ workspaceId: "default", installationId: installation.id });
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.operation, "prepare");
});

test("claim → resolve → complete drives the installation to ready", async () => {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  assert.equal(claimed!.status, "claimed");

  const resolved = await resolveClaimedSkillInstallationOperation({ workspaceId: "default", operation: claimed! });
  assert.ok(resolved);
  assert.equal(resolved!.artifactDigest, digest);
  assert.ok(resolved!.files.some((file) => file.path === "scripts/render.py" && file.mode === "0755"));

  const done = completeSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    componentStatuses: [
      { kind: "dependency", key: "npm:left-pad@1.3.0", status: "ready" },
      { kind: "script", key: "scripts/render.py", status: "ready" },
    ],
  });
  assert.equal(done, true);

  const refreshed = readSkillInstallationSync(installation.id, "default");
  assert.equal(refreshed?.status, "ready");

  const gate = assertSkillInstallationReadyForTaskSync({ runtimeId, artifactDigest: digest });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.installationId, installation.id);
  }
});

test("a failed prepare blocks components and the installation never reaches ready", () => {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);

  failSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    errorCode: "dependency.install_failed",
    errorMessage: "npm install exited non-zero",
  });

  const refreshed = readSkillInstallationSync(installation.id, "default");
  assert.equal(refreshed?.status, "blocked");

  const components = readSkillInstallationComponentsSync(installation.id);
  assert.ok(components.every((c) => c.status === "blocked"));

  const gate = assertSkillInstallationReadyForTaskSync({ runtimeId, artifactDigest: digest });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.status, "blocked");
  }
});

test("installation plan creation is idempotent by release lock", () => {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const first = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });
  const second = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });
  assert.equal(first.id, second.id);
});

async function completeAllComponents(installationId: string, runtimeId: string): Promise<void> {
  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  const resolved = await resolveClaimedSkillInstallationOperation({ workspaceId: "default", operation: claimed! });
  assert.ok(resolved);
  const done = completeSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    componentStatuses: resolved!.components.map((component) => ({ kind: component.kind, key: component.key, status: "ready" })),
  });
  assert.equal(done, true);
}

test("upgrade creates a candidate revision and rollback reactivates the previous ready digest", async () => {
  const skill = createWorkspaceSkillSync({ name: "Rollback Test", description: "rollback" });
  const runtimeId = createTestRuntime();
  const first = buildArtifact(skill.id);
  const v1 = createSkillInstallationPlanSync({ runtimeId, artifactDigest: first.digest });
  completeAllComponents(v1.id, runtimeId);

  // New artifact content → different digest.
  const second = buildAndPersistSkillArtifactSync({
    skillId: skill.id,
    name: "Install Test",
    files: [
      { path: "SKILL.md", bytes: encoder.encode("---\nname: Install Test v2\ndescription: changed\ndependencies:\n  - npm:left-pad@1.3.0\n---\n# Body v2\n") },
      { path: "scripts/render.py", bytes: encoder.encode("print('render v2')\n"), mode: "0755" },
    ],
    sourceType: "local",
    dependencies: [{ manager: "npm", name: "left-pad", version: "1.3.0" }],
  });
  assert.notEqual(second.digest, first.digest);

  const v2 = createSkillUpgradePlanSync({ runtimeId, artifactDigest: second.digest, previousReadyInstallationId: v1.id });
  assert.equal(v2.previousReadyRevision, "v1");
  completeAllComponents(v2.id, runtimeId);

  const rollback = rollbackSkillInstallationSync({ installationId: v2.id, workspaceId: "default", skillId: skill.id });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.previousReadyDigest, first.digest);

  const activeDigestAfterRollback = readActiveArtifactDigestForSkillSync(skill.id, "default");
  assert.equal(activeDigestAfterRollback, first.digest);

  const gateAfterRollback = assertSkillInstallationReadyForTaskSync({ runtimeId, artifactDigest: first.digest });
  assert.equal(gateAfterRollback.ok, true);
});
