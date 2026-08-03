import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { randomLikeId } from "@dofe-agent/db";
import {
  listSkillInstallApprovalsSync,
  readSkillArtifactByDigestSync,
  readSkillInstallApprovalSync,
} from "@dofe-agent/db";
import {
  approveSkillInstallSync,
  buildAndPersistSkillArtifactSync,
  buildSkillInstallRiskItemsSync,
  computeSkillReleaseLockSync,
  computeSkillInstallRiskDecisionDigestSync,
  createSkillInstallationPlanSync,
  resetWorkspaceStateSync,
} from "../index.ts";

const encoder = new TextEncoder();

beforeEach(() => {
  resetWorkspaceStateSync();
  getDatabase().exec("DELETE FROM skill_install_approval");
  getDatabase().exec("DELETE FROM skill_installation");
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

/** Risk-bearing artifact: executable script + dependency + write/exec MCP tools + service. */
function buildRiskyArtifact() {
  return buildAndPersistSkillArtifactSync({
    name: "Risky Install",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode("---\nname: Risky Install\ndescription: risk gate\n---\n# Body\n"),
      },
      { path: "scripts/run.sh", bytes: encoder.encode("#!/bin/sh\necho hi\n"), mode: "0755" },
    ],
    sourceType: "local",
    dependencies: [{ manager: "npm", name: "left-pad", version: "1.3.0" }],
    entrypoints: [{ id: "scripts-run", kind: "script", path: "scripts/run.sh", runtime: "bash" }],
    capabilities: [
      { kind: "mcp", catalogSlug: "github", requiredTools: ["create_file", "execute_shell"] },
    ],
    services: [{ catalogSlug: "postgres", templateVersion: "1", required: true }],
  });
}

/** Minimal artifact with no declarable risk. */
function buildBenignArtifact() {
  return buildAndPersistSkillArtifactSync({
    name: "Benign Install",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode("---\nname: Benign Install\ndescription: no risk\n---\n# Body\n"),
      },
    ],
    sourceType: "local",
  });
}

function readArtifactByDigest(digest: string) {
  const artifact = readSkillArtifactByDigestSync(digest, "default");
  if (!artifact) throw new Error("artifact missing");
  return artifact;
}

function approveArtifact(
  digest: string,
  reason = "admin reviewed",
  decision: "approved" | "rejected" = "approved",
) {
  const artifact = readArtifactByDigest(digest);
  const riskItems = buildSkillInstallRiskItemsSync({ artifactDigest: digest });
  const lock = computeSkillReleaseLockSync(artifact, "default");
  return {
    approvalId: approveSkillInstallSync({
      artifactDigest: digest,
      releaseLockDigest: lock.lockDigest,
      riskItems,
      reason,
      decision,
    }).approvalId,
    lockDigest: lock.lockDigest,
  };
}

test("risk classifier surfaces script, network, high-risk MCP, and write risk items", () => {
  const artifact = buildRiskyArtifact();
  const items = buildSkillInstallRiskItemsSync({ artifactDigest: artifact.digest });

  const categories = new Set(items.map((item) => item.category));
  assert.ok(categories.has("script"), "executable scripts must be flagged");
  assert.ok(categories.has("network"), "dependency / MCP / service network access must be flagged");
  assert.ok(categories.has("mcp_tool"), "high-risk MCP tools must be flagged");
  assert.ok(categories.has("write"), "write-capable MCP tools must be flagged");

  assert.ok(items.some((item) => item.key === "entrypoint:scripts/run.sh"));
  assert.ok(items.some((item) => item.key === "dependency:npm:left-pad@1.3.0"));
  assert.ok(items.some((item) => item.key === "mcp:github"));
  assert.ok(items.some((item) => item.key === "mcp_tool:github:create_file"));
  assert.ok(items.some((item) => item.key === "mcp_tool:github:execute_shell"));
  assert.ok(items.some((item) => item.key === "service:postgres"));
});

test("benign artifact produces no risk items and needs no approval", () => {
  const artifact = buildBenignArtifact();
  assert.deepEqual(buildSkillInstallRiskItemsSync({ artifactDigest: artifact.digest }), []);
  const runtimeId = createTestRuntime();
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });
  assert.ok(installation.id);
});

test("plan creation is blocked without a per-item approval for a risk-bearing artifact", () => {
  const artifact = buildRiskyArtifact();
  const runtimeId = createTestRuntime();
  assert.throws(
    () => createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest }),
    /需要逐项审批/,
  );
});

test("approval binds artifact + release lock + policy + risk decision digest and is consumed atomically", () => {
  const artifact = buildRiskyArtifact();
  const runtimeId = createTestRuntime();
  const { approvalId } = approveArtifact(artifact.digest);

  const riskItems = buildSkillInstallRiskItemsSync({ artifactDigest: artifact.digest });
  const lock = computeSkillReleaseLockSync(readArtifactByDigest(artifact.digest), "default");
  const decisionDigest = computeSkillInstallRiskDecisionDigestSync({
    artifactDigest: artifact.digest,
    releaseLockDigest: lock.lockDigest,
    riskItems,
  });

  const installation = createSkillInstallationPlanSync({
    runtimeId,
    artifactDigest: artifact.digest,
    approvalId,
  });
  assert.ok(installation.id);

  const approval = readSkillInstallApprovalSync(approvalId, "default");
  assert.ok(approval);
  assert.equal(approval.artifactDigest, artifact.digest);
  assert.equal(approval.releaseLockDigest, lock.lockDigest);
  assert.equal(approval.policyVersion, "v1");
  assert.equal(approval.riskDecisionDigest, decisionDigest);
  assert.ok(approval.consumedAt, "approval must be consumed by the plan transaction");
});

test("a rejected approval never unlocks plan creation", () => {
  const artifact = buildRiskyArtifact();
  const runtimeId = createTestRuntime();
  const { approvalId } = approveArtifact(artifact.digest, "denied", "rejected");
  assert.throws(
    () => createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest, approvalId }),
    /不是 approved/,
  );
});

test("an approval for a different artifact / lock / risk set is rejected", () => {
  const artifact = buildRiskyArtifact();
  const other = buildBenignArtifact();
  const runtimeId = createTestRuntime();

  // Approval bound to the benign artifact cannot unlock the risky one.
  const { approvalId: benignApproval } = approveArtifact(other.digest);
  assert.throws(
    () => createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest, approvalId: benignApproval }),
    /不匹配/,
  );

  // Approval for the current artifact unlocks the current plan…
  const { approvalId: matchingApproval } = approveArtifact(artifact.digest);
  assert.doesNotThrow(() =>
    createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest, approvalId: matchingApproval }),
  );
});

test("a consumed approval cannot be reused by a second plan", () => {
  const artifact = buildRiskyArtifact();
  const runtimeId = createTestRuntime();
  const { approvalId } = approveArtifact(artifact.digest);

  const first = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest, approvalId });
  assert.ok(first.id);

  const runtimeId2 = createTestRuntime();
  assert.throws(
    () => createSkillInstallationPlanSync({ runtimeId: runtimeId2, artifactDigest: artifact.digest, approvalId }),
    /已.*消费|并发消费/,
  );
});

test("approval records are listable for audit", () => {
  const artifact = buildRiskyArtifact();
  approveArtifact(artifact.digest, "audit trail");
  const approvals = listSkillInstallApprovalsSync("default");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].reason, "audit trail");
  assert.ok(approvals[0].riskItems.length > 0);
  assert.equal(approvals[0].decision, "approved");
});
