import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { beforeEach } from "node:test";
import {
  claimNextSkillInstallationOperationForRuntimeSync,
  getDatabase,
  listAuditLogsSync,
  randomLikeId,
  readSkillArtifactByDigestSync,
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
  failSkillInstallationOperationSync,
  resetWorkspaceStateSync,
} from "../index.ts";

const encoder = new TextEncoder();

beforeEach(() => {
  resetWorkspaceStateSync();
  getDatabase().exec("DELETE FROM audit_log WHERE code LIKE 'skill.%'");
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
  const diffHash = computeSkillUpgradeDiffHashSync({
    fromManifestJson: first.artifact.manifestJson,
    toManifestJson: second.artifact.manifestJson,
  });

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
