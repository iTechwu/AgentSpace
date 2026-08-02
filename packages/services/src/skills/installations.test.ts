import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { randomLikeId } from "@dofe-agent/db";
import {
  claimNextSkillInstallationOperationForRuntimeSync,
  listSkillInstallationOperationsSync,
  readActiveArtifactDigestForSkillSync,
  readSkillInstallationComponentsSync,
  readSkillInstallationOperationSync,
  readSkillInstallationSync,
} from "@dofe-agent/db";
import {
  approveSkillUpgradeSync,
  assertSkillInstallationReadyForTaskSync,
  buildAndPersistSkillArtifactSync,
  completeSkillInstallationOperationSync,
  computeSkillUpgradeDiffHashSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  createWorkspaceSkillSync,
  failSkillInstallationOperationSync,
  parseCompleteSkillInstallationOperationPayload,
  parseFailSkillInstallationOperationPayload,
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
  getDatabase().exec("DELETE FROM skill_upgrade_approval");
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

  // The installation carries a REAL release lock (dependency digest + lock digest), not placeholders.
  const lock = JSON.parse(installation.resolvedLockJson) as { dependencyLockDigest: string; lockDigest: string };
  assert.equal(lock.dependencyLockDigest.length, 64);
  assert.equal(lock.lockDigest.length, 64);

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
  assert.equal(resolved!.releaseLockDigest?.length, 64, "claim carries the release lock digest");
  assert.ok(resolved!.files.some((file) => file.path === "scripts/render.py" && file.mode === "0755"));

  const done = completeSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: [
      { kind: "dependency", key: "npm:left-pad@1.3.0", status: "ready" },
      { kind: "script", key: "scripts/render.py", status: "ready" },
    ],
  });
  assert.equal(done.ok, true);

  const refreshed = readSkillInstallationSync(installation.id, "default");
  assert.equal(refreshed?.status, "ready");

  const gate = assertSkillInstallationReadyForTaskSync({ runtimeId, artifactDigest: digest });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.installationId, installation.id);
  }
});

test("completion records the daemon's Runtime cache preparedPath + preparedDigest", () => {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);

  const done = completeSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({
      materializedFiles: 2,
      computedDigest: digest,
      cacheHit: false,
      preparedPath: "/tmp/state/skill-install-cache/abc123",
    }),
    componentStatuses: [
      { kind: "dependency", key: "npm:left-pad@1.3.0", status: "ready" },
      { kind: "script", key: "scripts/render.py", status: "ready" },
    ],
  });
  assert.equal(done.ok, true);

  const refreshed = readSkillInstallationSync(installation.id, "default");
  assert.equal(refreshed?.status, "ready");
  assert.equal(refreshed?.preparedPath, "/tmp/state/skill-install-cache/abc123");
  assert.equal(refreshed?.preparedDigest, digest);
});

test("a failed prepare blocks components and the installation never reaches ready", () => {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);

  const failed = failSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    errorCode: "dependency.install_failed",
    errorMessage: "npm install exited non-zero",
  });
  assert.equal(failed.ok, true);

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
    safeResultJson: JSON.stringify({ computedDigest: resolved!.artifactDigest }),
    componentStatuses: resolved!.components.map((component) => ({ kind: component.kind, key: component.key, status: "ready" })),
  });
  assert.equal(done.ok, true);
}

test("upgrade creates a candidate revision and rollback reactivates the previous ready digest", async () => {
  const skill = createWorkspaceSkillSync({ name: "Rollback Test", description: "rollback" });
  const runtimeId = createTestRuntime();
  const first = buildArtifact(skill.id);
  const v1 = createSkillInstallationPlanSync({ runtimeId, artifactDigest: first.digest });
  await completeAllComponents(v1.id, runtimeId);

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

  // The upgrade is a breaking diff, so it needs an immutable approval bound to
  // the exact (fromDigest, toDigest, diffHash) before the plan can be created.
  const diffHash = computeSkillUpgradeDiffHashSync({
    fromManifestJson: first.artifact.manifestJson,
    toManifestJson: second.artifact.manifestJson,
  });
  const { approvalId } = approveSkillUpgradeSync({
    skillId: skill.id,
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash,
  });

  const v2 = createSkillUpgradePlanSync({
    runtimeId,
    artifactDigest: second.digest,
    previousReadyInstallationId: v1.id,
    approvalId,
  });
  assert.equal(v2.previousReadyRevision, "v1");
  // The upgrade candidate stores a real lock (not the old "{}" placeholder).
  const v2Lock = JSON.parse(v2.resolvedLockJson) as { lockDigest: string };
  assert.equal(v2Lock.lockDigest.length, 64);
  await completeAllComponents(v2.id, runtimeId);

  const rollback = rollbackSkillInstallationSync({ installationId: v2.id, workspaceId: "default", skillId: skill.id });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.previousReadyDigest, first.digest);

  const activeDigestAfterRollback = readActiveArtifactDigestForSkillSync(skill.id, "default");
  assert.equal(activeDigestAfterRollback, first.digest);

  const gateAfterRollback = assertSkillInstallationReadyForTaskSync({ runtimeId, artifactDigest: first.digest });
  assert.equal(gateAfterRollback.ok, true);
});

/* ------------------------------------------------------------------ */
/* P0-5: complete/fail protocol integrity (fail-closed)                 */
/* ------------------------------------------------------------------ */

const EXPECTED_COMPONENTS = [
  { kind: "dependency" as const, key: "npm:left-pad@1.3.0" },
  { kind: "script" as const, key: "scripts/render.py" },
];

function readyStatuses(components: typeof EXPECTED_COMPONENTS) {
  return components.map((component) => ({ ...component, status: "ready" as const }));
}

function setupClaimedPrepareOperation(): {
  runtimeId: string;
  digest: string;
  installationId: string;
  claimed: NonNullable<ReturnType<typeof claimNextSkillInstallationOperationForRuntimeSync>>;
} {
  const runtimeId = createTestRuntime();
  const { digest } = buildArtifact();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: digest });
  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  return { runtimeId, digest, installationId: installation.id, claimed: claimed! };
}

function assertOperationState(
  operationId: string,
  expected: { status: string; componentStatuses: string[] },
): void {
  const operation = readSkillInstallationOperationSync(operationId, "default");
  assert.ok(operation);
  assert.equal(operation.status, expected.status);
  const components = readSkillInstallationComponentsSync(operation.installationId);
  const byKey = new Map(components.map((component) => [`${component.kind}:${component.key}`, component.status]));
  for (const [key, status] of Object.entries(expected.componentStatuses)) {
    assert.equal(byKey.get(key), status, `expected component "${key}" to be ${status}`);
  }
}

test("complete rejects a duplicate component key and leaves the operation claimed", () => {
  const { claimed, digest } = setupClaimedPrepareOperation();
  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: [
      ...readyStatuses(EXPECTED_COMPONENTS),
      { kind: "dependency", key: "npm:left-pad@1.3.0", status: "ready" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "component_set_mismatch");
  }
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete rejects an unknown component and leaves the operation claimed", () => {
  const { claimed, digest } = setupClaimedPrepareOperation();
  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: [
      ...readyStatuses(EXPECTED_COMPONENTS),
      { kind: "script", key: "scripts/evil.sh", status: "ready" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "component_set_mismatch");
  }
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete rejects a missing component and leaves the operation claimed", () => {
  const { claimed, digest } = setupClaimedPrepareOperation();
  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: readyStatuses([EXPECTED_COMPONENTS[0]!]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "component_set_mismatch");
  }
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete rejects evidence whose digest does not match the artifact", () => {
  const { claimed, installationId } = setupClaimedPrepareOperation();
  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: "deadbeef".repeat(8) }),
    componentStatuses: readyStatuses(EXPECTED_COMPONENTS),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "evidence_mismatch");
  }
  const refreshed = readSkillInstallationSync(installationId, "default");
  assert.notEqual(refreshed?.preparedDigest, "deadbeef".repeat(8));
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete rejects malformed or empty evidence", () => {
  const { claimed } = setupClaimedPrepareOperation();
  for (const safeResultJson of ["not-json", "{}", undefined]) {
    const result = completeSkillInstallationOperationSync({
      operationId: claimed.id,
      workspaceId: "default",
      safeResultJson,
      componentStatuses: readyStatuses(EXPECTED_COMPONENTS),
    });
    assert.equal(result.ok, false, `expected rejection for safeResultJson=${safeResultJson}`);
    if (!result.ok) {
      assert.equal(result.code, "evidence_mismatch");
    }
  }
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete is atomic: a missing component row rolls back the op succeed", () => {
  const { claimed, installationId, digest } = setupClaimedPrepareOperation();
  // Simulate drift: delete one live component row so the set-match passes (from
  // the frozen snapshot) but the UPDATE inside the transaction hits 0 rows.
  getDatabase().prepare(
    `DELETE FROM skill_installation_component WHERE installation_id = ? AND kind = ? AND key = ?`,
  ).run(installationId, "script", "scripts/render.py");

  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: readyStatuses(EXPECTED_COMPONENTS),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "component_set_mismatch");
  }
  // The op must NOT be succeeded and the surviving component must be untouched.
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("fail accepts partial component statuses and blocks the remainder", () => {
  const { claimed } = setupClaimedPrepareOperation();
  const failed = failSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    errorCode: "skill_installation.verify_failed",
    errorMessage: "script syntax check failed",
    componentStatuses: [
      { kind: "dependency", key: "npm:left-pad@1.3.0", status: "ready" },
      { kind: "script", key: "scripts/render.py", status: "failed", errorCode: "skill_installation.script_syntax_error" },
    ],
  });
  assert.equal(failed.ok, true);
  assertOperationState(claimed.id, {
    status: "failed",
    componentStatuses: {
      "dependency:npm:left-pad@1.3.0": "ready",
      "script:scripts/render.py": "failed",
    },
  });
});

test("fail rejects a component that is not in the expected set", () => {
  const { claimed } = setupClaimedPrepareOperation();
  const failed = failSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    errorCode: "x",
    errorMessage: "boom",
    componentStatuses: [{ kind: "script", key: "scripts/evil.sh", status: "failed" }],
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, "component_set_mismatch");
  }
  assertOperationState(claimed.id, { status: "claimed", componentStatuses: { "dependency:npm:left-pad@1.3.0": "pending" } });
});

test("complete falls back to the live component set for legacy request snapshots", async () => {
  const { claimed, installationId, digest } = setupClaimedPrepareOperation();
  // Rewrite the request snapshot to the legacy shape (no expectedComponents).
  getDatabase().prepare(
    `UPDATE skill_installation_operation SET request_snapshot_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ artifactDigest: digest, components: EXPECTED_COMPONENTS.map((c) => c.key) }), claimed.id);

  const result = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: readyStatuses(EXPECTED_COMPONENTS),
  });
  assert.equal(result.ok, true);
  assert.equal(readSkillInstallationSync(installationId, "default")?.status, "ready");
});

test("shared payload parsers reject malformed complete/fail bodies", () => {
  const badComplete = parseCompleteSkillInstallationOperationPayload({ componentStatuses: [{ kind: "script", key: "x.sh", status: "banana" }] });
  assert.equal(badComplete.ok, false);
  const dup = parseCompleteSkillInstallationOperationPayload({
    componentStatuses: [
      { kind: "script", key: "x.sh", status: "ready" },
      { kind: "script", key: "x.sh", status: "ready" },
    ],
  });
  assert.equal(dup.ok, false);
  const unknownKind = parseCompleteSkillInstallationOperationPayload({ componentStatuses: [{ kind: "plugin", key: "x", status: "ready" }] });
  assert.equal(unknownKind.ok, false);
  const nonObject = parseCompleteSkillInstallationOperationPayload("nope");
  assert.equal(nonObject.ok, false);

  const badFail = parseFailSkillInstallationOperationPayload({ errorMessage: 42 });
  assert.equal(badFail.ok, false);
  const missingMessage = parseFailSkillInstallationOperationPayload({});
  assert.equal(missingMessage.ok, false);
  const okFail = parseFailSkillInstallationOperationPayload({ errorMessage: "boom", componentStatuses: [{ kind: "script", key: "x.sh", status: "failed" }] });
  assert.equal(okFail.ok, true);
});
