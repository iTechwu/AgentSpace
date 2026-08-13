import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import {
  claimNextSkillInstallationOperationForRuntimeSync,
  getDatabase,
  listAuditLogsSync,
  randomLikeId,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  readSkillInstallationComponentsSync,
  setActiveArtifactDigestForSkillSync,
  setSkillInstallationStatusSync,
  updateSkillInstallationComponentStatusSync,
} from "@dofe-agent/db";
import {
  approveSkillInstallSync,
  approveSkillUpgradeSync,
  buildAndPersistSkillArtifactSync,
  buildSkillInstallRiskItemsSync,
  completeSkillInstallationOperationSync,
  computeSkillReleaseLockSync,
  computeSkillUpgradeDiffHashSync,
  createSkillInstallationPlanSync,
  createSkillUpgradePlanSync,
  createWorkspaceSkillSync,
  failSkillInstallationOperationSync,
  promoteSkillUpgradeSync,
  resetWorkspaceStateSync,
  rollbackSkillInstallationSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testStorage = createTestTosAttachmentStorage();

// Pin an in-memory storage client so artifact builds never touch real TOS. Real
// storage I/O (curl/network) recycles pooled PG connections mid-test, producing
// stale-snapshot errors ("Runtime does not exist", skill_artifact FK violations)
// on back-to-back runs — the same reason installations.test.ts pins a test client.
before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  testStorage.clear();
  getDatabase().exec("DELETE FROM audit_log WHERE code LIKE 'skill.%'");
});

after(() => {
  testStorage.clear();
});

function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

// Salt name + body so every call yields a fresh digest AND a unique skill name.
// The `skill` master table enforces UNIQUE(workspace_id, name) and approvals are
// first-write-wins by digest; static names/digests collide across runs in the
// shared test database. Mirrors the salting pattern in release.test.ts.
function buildArtifact(name: string, withScript: boolean) {
  const salt = randomBytes(4).toString("hex");
  return buildAndPersistSkillArtifactSync({
    name: `${name} ${salt}`,
    files: [
      { path: "SKILL.md", bytes: encoder.encode(`---\nname: ${name} ${salt}\ndescription: audit\n---\n# Body ${salt}\n`) },
      ...(withScript
        ? [{ path: "scripts/run.sh", bytes: encoder.encode(`#!/bin/sh\necho hi ${salt}\n`), mode: "0755" as const }]
        : []),
    ],
    sourceType: "local",
    ...(withScript
      ? { entrypoints: [{ id: "scripts-run", kind: "script" as const, path: "scripts/run.sh", runtime: "bash" as const }] }
      : {}),
  });
}

function readArtifact(digest: string) {
  const artifact = readSkillArtifactByDigestSync(digest, "default");
  if (!artifact) throw new Error("artifact missing");
  return artifact;
}

/** Approve + plan: obtains a fresh per-item risk approval bound to the release lock. */
function approvedPlan(runtimeId: string, artifactDigest: string) {
  const riskItems = buildSkillInstallRiskItemsSync({ artifactDigest });
  const lock = computeSkillReleaseLockSync(readArtifact(artifactDigest), "default");
  const { approvalId } = approveSkillInstallSync({
    artifactDigest,
    releaseLockDigest: lock.lockDigest,
    riskItems,
    reason: "audit test",
  });
  return createSkillInstallationPlanSync({ runtimeId, artifactDigest, approvalId });
}

/**
 * Drive an installation through the real claim→complete flow so it reaches ready
 * WITH preparation evidence (preparedDigest). Rollback's preflight rejects a
 * target whose preparedDigest is missing, so the ready-status shortcut is not
 * enough for the previous revision.
 */
function completeInstall(runtimeId: string, artifactDigest: string) {
  const installation = approvedPlan(runtimeId, artifactDigest);
  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  if (!claimed) throw new Error("no operation queued for completion");
  const done = completeSkillInstallationOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    safeResultJson: JSON.stringify({ computedDigest: artifactDigest }),
    componentStatuses: [{ kind: "script", key: "scripts/run.sh", status: "ready" }],
  });
  if (!done.ok) throw new Error(`complete failed for installation ${installation.id}`);
  return installation;
}

/** Two distinct artifacts bound to the same skill lineage (v1 + v2 upgrade pair). */
function buildUpgradeArtifacts(skillId: string) {
  const salt = randomBytes(4).toString("hex");
  const first = buildAndPersistSkillArtifactSync({
    skillId,
    name: `Upgrade Audit ${salt}`,
    files: [
      { path: "SKILL.md", bytes: encoder.encode(`---\nname: Upgrade Audit ${salt}\ndescription: audit\n---\n# Body v1 ${salt}\n`) },
      { path: "scripts/run.sh", bytes: encoder.encode(`#!/bin/sh\necho v1 ${salt}\n`), mode: "0755" as const },
    ],
    sourceType: "local",
    entrypoints: [{ id: "scripts-run", kind: "script" as const, path: "scripts/run.sh", runtime: "bash" as const }],
  });
  const second = buildAndPersistSkillArtifactSync({
    skillId,
    activate: false,
    name: `Upgrade Audit ${salt}`,
    files: [
      { path: "SKILL.md", bytes: encoder.encode(`---\nname: Upgrade Audit ${salt}\ndescription: audit\n---\n# Body v2 ${salt}\n`) },
      { path: "scripts/run.sh", bytes: encoder.encode(`#!/bin/sh\necho v2 ${salt}\n`), mode: "0755" as const },
    ],
    sourceType: "local",
    entrypoints: [{ id: "scripts-run", kind: "script" as const, path: "scripts/run.sh", runtime: "bash" as const }],
  });
  return { first, second };
}

function upgradeDiffHash(first: { artifact: { manifestJson: string } }, second: { artifact: { manifestJson: string } }): string {
  return computeSkillUpgradeDiffHashSync({
    fromManifestJson: first.artifact.manifestJson,
    toManifestJson: second.artifact.manifestJson,
  });
}

/**
 * Drives a full upgrade to completion: v1 ready → v2 upgrade plan (approved) →
 * v2 ready → promote. Returns the promoted v2 candidate so callers can assert
 * the upgrade_promoted audit row or drive a subsequent rollback.
 */
function promotedUpgrade(): { skillId: string; candidate: { id: string; artifactDigest: string }; firstDigest: string } {
  const runtimeId = createTestRuntime();
  const skill = createWorkspaceSkillSync({ name: `Promote ${randomBytes(3).toString("hex")}` });
  const { first, second } = buildUpgradeArtifacts(skill.id);
  setActiveArtifactDigestForSkillSync({ skillId: skill.id, digest: first.digest, workspaceId: "default" });
  const previous = completeInstall(runtimeId, first.digest);
  const diffHash = upgradeDiffHash(first, second);
  const { approvalId } = approveSkillUpgradeSync({
    skillId: skill.id,
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash,
  });
  const candidate = createSkillUpgradePlanSync({
    runtimeId,
    artifactDigest: second.digest,
    previousReadyInstallationId: previous.id,
    approvalId,
  });
  for (const component of readSkillInstallationComponentsSync(candidate.id)) {
    updateSkillInstallationComponentStatusSync({
      installationId: candidate.id,
      kind: component.kind,
      key: component.key,
      status: "ready",
      verifiedAt: new Date().toISOString(),
    });
  }
  setSkillInstallationStatusSync({
    installationId: candidate.id,
    workspaceId: "default",
    status: "ready",
    health: "healthy",
  });
  const promoted = promoteSkillUpgradeSync({
    installationId: candidate.id,
    skillId: skill.id,
    expectedPreviousDigest: first.digest,
  });
  if (!promoted.ok) throw new Error(`promote failed: ${promoted.reason}`);
  return { skillId: skill.id, candidate: { id: candidate.id, artifactDigest: candidate.artifactDigest }, firstDigest: first.digest };
}

test("install approval decision is recorded in the immutable audit log", () => {
  const artifact = buildArtifact("Audit Risky", true);
  const riskItems = buildSkillInstallRiskItemsSync({ artifactDigest: artifact.digest });
  const lock = computeSkillReleaseLockSync(readArtifact(artifact.digest), "default");

  const { approvalId } = approveSkillInstallSync({
    artifactDigest: artifact.digest,
    releaseLockDigest: lock.lockDigest,
    riskItems,
    reason: "audit test",
  });

  const rows = listAuditLogsSync("default", { code: "skill.install_approval_decision" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(approvalId));
  assert.match(rows[0]!.note, /approved/);
});

test("installation plan creation is recorded in the immutable audit log", () => {
  const artifact = buildArtifact("Audit Benign", false);
  const runtimeId = createTestRuntime();

  const installation = createSkillInstallationPlanSync({
    runtimeId,
    artifactDigest: artifact.digest,
  });

  const rows = listAuditLogsSync("default", { code: "skill.installation_plan_created" });
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.note, new RegExp(installation.id));
  assert.match(rows[0]!.note, new RegExp(runtimeId));
});

test("installation operation completion is recorded in the immutable audit log", async () => {
  const runtimeId = createTestRuntime();
  const digest = buildArtifact("Audit Op Complete", true).digest;
  approvedPlan(runtimeId, digest);

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed, "a prepare operation should be queued for the new plan");

  const done = completeSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    claimGeneration: claimed!.claimGeneration,
    safeResultJson: JSON.stringify({ computedDigest: digest }),
    componentStatuses: [{ kind: "script", key: "scripts/run.sh", status: "ready" }],
  });
  assert.equal(done.ok, true);

  const rows = listAuditLogsSync("default", { code: "skill.installation_operation_completed" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(claimed!.id));
});

test("installation operation failure is recorded in the immutable audit log", () => {
  const runtimeId = createTestRuntime();
  const digest = buildArtifact("Audit Op Failed", true).digest;
  approvedPlan(runtimeId, digest);

  const claimed = claimNextSkillInstallationOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);

  const failed = failSkillInstallationOperationSync({
    operationId: claimed!.id,
    workspaceId: "default",
    claimGeneration: claimed!.claimGeneration,
    errorCode: "script.prepare_failed",
    errorMessage: "audit failure path",
  });
  assert.equal(failed.ok, true);

  const rows = listAuditLogsSync("default", { code: "skill.installation_operation_failed" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(claimed!.id));
  assert.match(rows[0]!.note, /script.prepare_failed/);
});

test("upgrade approval decision is recorded in the immutable audit log", () => {
  const first = buildArtifact("Audit Upgrade", true);
  const second = buildArtifact("Audit Upgrade", true);
  assert.notEqual(first.digest, second.digest, "salted artifacts must produce distinct digests");
  const diffHash = upgradeDiffHash(first, second);

  const { approvalId } = approveSkillUpgradeSync({
    fromDigest: first.digest,
    toDigest: second.digest,
    diffHash,
  });

  const rows = listAuditLogsSync("default", { code: "skill.upgrade_approval_decision" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(approvalId));
  assert.match(rows[0]!.note, /approved/);
});

test("upgrade promotion is recorded in the immutable audit log", () => {
  const { skillId, candidate } = promotedUpgrade();
  assert.equal(readActiveArtifactDigestForSkillSync(skillId, "default"), candidate.artifactDigest);

  const rows = listAuditLogsSync("default", { code: "skill.upgrade_promoted" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(skillId));
  assert.match(rows[0]!.note, new RegExp(candidate.artifactDigest));
});

test("installation rollback is recorded in the immutable audit log", () => {
  const { skillId, candidate, firstDigest } = promotedUpgrade();

  const rollback = rollbackSkillInstallationSync({ installationId: candidate.id, skillId });
  assert.equal(rollback.ok, true, `rollback should succeed: ${rollback.reason ?? ""}`);
  assert.equal(readActiveArtifactDigestForSkillSync(skillId, "default"), firstDigest, "rollback restores the previous digest");

  const rows = listAuditLogsSync("default", { code: "skill.installation_rollback" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "skill_lifecycle");
  assert.match(rows[0]!.note, new RegExp(candidate.id));
});
