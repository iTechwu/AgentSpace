import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  computeSkillRolloutItemsSync,
  computeSkillRolloutPlanDigestSync,
  computeSkillRolloutTargetRuntimesSync,
  isRuntimeCompatibleWithRequirements,
  lockSkillDependencyDigestSync,
  planSkillRollout,
  resetWorkspaceStateSync,
  resolveSkillDependencyClosureSync,
  setAttachmentStorageClientForTests,
  versionSatisfies,
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

function createRuntime(metadata: Record<string, unknown> = {}): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, metadata_json, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?, ?)`,
  ).run(id, `Runtime ${id}`, JSON.stringify(metadata), now, now);
  return id;
}

function buildArtifact(input: {
  name: string;
  version?: string;
  coordinate?: string;
  network?: { egressAllowlist?: string[] };
  runtimeRequirements?: { gpu?: boolean };
  skillDependencies?: Array<{ coordinate: string; version: string; placement: "same_runtime" | "workflow"; required?: boolean }>;
}) {
  return buildAndPersistSkillArtifactSync({
    name: input.name,
    version: input.version ?? "1.0.0",
    files: [{ path: "SKILL.md", bytes: encoder.encode(`---
name: ${input.name}
---
# Body
`) }],
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo",
    coordinate: input.coordinate,
    ...(input.network ? { network: input.network } : {}),
    ...(input.runtimeRequirements ? { runtimeRequirements: input.runtimeRequirements } : {}),
    ...(input.skillDependencies ? { skillDependencies: input.skillDependencies } : {}),
  });
}

test("versionSatisfies supports exact, caret, tilde and wildcard ranges", () => {
  assert.equal(versionSatisfies("1.2.0", "^1.0.0"), true);
  assert.equal(versionSatisfies("2.0.0", "^1.0.0"), false);
  assert.equal(versionSatisfies("1.2.0", "1.2.0"), true);
  assert.equal(versionSatisfies("1.2.0", "1.2.1"), false);
  assert.equal(versionSatisfies("1.2.5", "~1.2.0"), true);
  assert.equal(versionSatisfies("1.3.0", "~1.2.0"), false);
  assert.equal(versionSatisfies("9.9.9", "*"), true);
});

test("resolveSkillDependencyClosureSync resolves coordinate ranges to exact digests", () => {
  const dep = buildArtifact({ name: "dep", version: "1.2.0", coordinate: "github:owner/repo/skills/dep" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [
      { coordinate: "github:owner/repo/skills/dep", version: "^1.0.0", placement: "same_runtime", required: true },
    ],
  });

  const closure = resolveSkillDependencyClosureSync({ rootArtifactDigest: root.digest });
  assert.deepEqual(closure, [
    {
      coordinate: "github:owner/repo/skills/dep",
      artifactDigest: dep.digest,
      requestedVersion: "^1.0.0",
      placement: "same_runtime",
      required: true,
      parentArtifactDigest: root.digest,
    },
  ]);
});

test("resolveSkillDependencyClosureSync rejects cycles", () => {
  const a = buildArtifact({
    name: "a",
    coordinate: "github:owner/repo/skills/a",
    skillDependencies: [{ coordinate: "github:owner/repo/skills/b", version: "^1.0.0", placement: "workflow", required: true }],
  });
  buildArtifact({
    name: "b",
    coordinate: "github:owner/repo/skills/b",
    skillDependencies: [{ coordinate: "github:owner/repo/skills/a", version: "^1.0.0", placement: "workflow", required: true }],
  });

  assert.throws(
    () => resolveSkillDependencyClosureSync({ rootArtifactDigest: a.digest }),
    /skill_dependency_cycle/,
  );
});

test("lockSkillDependencyDigestSync fails closed when no artifact satisfies the range", () => {
  buildArtifact({ name: "dep", version: "1.2.0", coordinate: "github:owner/repo/skills/dep" });
  assert.throws(
    () => lockSkillDependencyDigestSync("github:owner/repo/skills/dep", "^2.0.0", "default"),
    /skill_dependency_unresolved/,
  );
});

test("computeSkillRolloutTargetRuntimesSync returns the runtime scope unchanged", () => {
  const r1 = createRuntime();
  const r2 = createRuntime();
  assert.deepEqual(
    computeSkillRolloutTargetRuntimesSync({ kind: "runtimes", runtimeIds: [r1, r2, r1] }, "default"),
    [r1, r2],
  );
});

test("all-compatible filters Runtime metadata capabilities and fails closed", () => {
  const requirements = {
    gpu: true,
    egress: true,
    mcp: ["catalog-mcp"],
    cli: ["catalog-cli"],
  };
  assert.equal(isRuntimeCompatibleWithRequirements(JSON.stringify({
    runtimeCapabilities: { schemaVersion: 1, gpu: true, egress: true, mcp: ["catalog-mcp"], cli: ["catalog-cli"] },
  }), requirements), true);
  assert.equal(isRuntimeCompatibleWithRequirements(JSON.stringify({
    runtimeCapabilities: { schemaVersion: 1, gpu: false, egress: true, mcp: ["catalog-mcp"], cli: ["catalog-cli"] },
  }), requirements), false);
  assert.equal(isRuntimeCompatibleWithRequirements("{}", requirements), false);
});

test("planSkillRollout filters all-compatible targets from manifest requirements", () => {
  const compatible = createRuntime({
    runtimeCapabilities: { schemaVersion: 1, gpu: true, egress: true, mcp: [], cli: [] },
  });
  createRuntime({ runtimeCapabilities: { schemaVersion: 1, gpu: false, egress: true, mcp: [], cli: [] } });
  const root = buildArtifact({
    name: "gpu-egress-root",
    coordinate: "github:owner/repo/skills/gpu-egress-root",
    network: { egressAllowlist: ["api.example.com"] },
    runtimeRequirements: { gpu: true },
  });
  const plan = planSkillRollout({ rootArtifactDigest: root.digest, targetScope: { kind: "all-compatible" } });
  assert.deepEqual(plan.items.map((item) => item.runtimeId), [compatible]);
});

test("all-compatible rejects a plan when no Runtime satisfies requirements", () => {
  createRuntime({ runtimeCapabilities: { schemaVersion: 1, gpu: false, egress: false, mcp: [], cli: [] } });
  const root = buildArtifact({
    name: "gpu-root",
    coordinate: "github:owner/repo/skills/gpu-root",
    runtimeRequirements: { gpu: true },
  });
  assert.throws(
    () => planSkillRollout({ rootArtifactDigest: root.digest, targetScope: { kind: "all-compatible" } }),
    /skill_rollout_no_compatible_runtime/,
  );
});

test("planSkillRollout builds closure, items and a stable digest", () => {
  const dep = buildArtifact({ name: "dep", version: "1.2.0", coordinate: "github:owner/repo/skills/dep" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [
      { coordinate: "github:owner/repo/skills/dep", version: "^1.0.0", placement: "same_runtime", required: true },
    ],
  });
  const runtimeId = createRuntime();

  const plan = planSkillRollout({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
  });

  assert.equal(plan.root.artifactDigest, root.digest);
  assert.equal(plan.closure.length, 1);
  assert.equal(plan.closure[0]?.artifactDigest, dep.digest);
  assert.equal(plan.items.length, 2, "root + one dependency on one runtime");
  assert.equal(plan.pendingCount, 2);
  assert.equal(plan.requiredCount, 2);
  assert.equal(plan.planDigest.length, 64);

  const again = planSkillRollout({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
  });
  assert.equal(again.planDigest, plan.planDigest, "plan digest is reproducible");
});

test("computeSkillRolloutItemsSync honors placement (same_runtime co-locates, workflow on primary)", () => {
  const r1 = createRuntime();
  const r2 = createRuntime();
  const sameDep = buildArtifact({ name: "same-dep", version: "1.0.0", coordinate: "github:owner/repo/skills/same-dep" });
  const workflowDep = buildArtifact({ name: "workflow-dep", version: "1.0.0", coordinate: "github:owner/repo/skills/workflow-dep" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [
      { coordinate: "github:owner/repo/skills/same-dep", version: "^1.0.0", placement: "same_runtime", required: true },
      { coordinate: "github:owner/repo/skills/workflow-dep", version: "^1.0.0", placement: "workflow", required: true },
    ],
  });

  const closure = resolveSkillDependencyClosureSync({ rootArtifactDigest: root.digest });
  const items = computeSkillRolloutItemsSync({
    rootArtifactDigest: root.digest,
    closure,
    rootRuntimeIds: [r1, r2],
    primaryRuntimeId: r1,
  });

  const pairs = items.map((item) => `${item.runtimeId}:${item.artifactDigest}`);
  assert.ok(pairs.includes(`${r1}:${root.digest}`));
  assert.ok(pairs.includes(`${r2}:${root.digest}`));
  assert.ok(pairs.includes(`${r1}:${sameDep.digest}`), "same_runtime dep co-locates with root on r1");
  assert.ok(pairs.includes(`${r2}:${sameDep.digest}`), "same_runtime dep co-locates with root on r2");
  assert.ok(pairs.includes(`${r1}:${workflowDep.digest}`), "workflow dep on primary runtime");
  assert.ok(!pairs.includes(`${r2}:${workflowDep.digest}`), "workflow dep must NOT be on every runtime");
  assert.equal(items.length, 5);
});

test("planSkillRollout records skipped optional deps in required-only mode", () => {
  buildArtifact({ name: "optional-dep", version: "1.0.0", coordinate: "github:owner/repo/skills/optional-dep" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [{ coordinate: "github:owner/repo/skills/optional-dep", version: "^1.0.0", placement: "workflow", required: false }],
  });
  const plan = planSkillRollout({ rootArtifactDigest: root.digest, targetScope: { kind: "runtimes", runtimeIds: [createRuntime()] } });
  assert.equal(plan.closure.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]?.coordinate, "github:owner/repo/skills/optional-dep");
  assert.equal(plan.items.length, 1, "root only (optional dep excluded)");
});

test("plan digest binds dependency parent placement anchors", () => {
  const risks = { totalRiskItems: 0, artifactsWithRisk: [], riskItems: [] };
  const base = {
    rootArtifactDigest: "root",
    targetRuntimes: ["runtime-1"],
    risks,
  };
  const first = computeSkillRolloutPlanDigestSync({
    ...base,
    closure: [{
      coordinate: "github:owner/repo/skills/dep",
      artifactDigest: "dep",
      requestedVersion: "^1.0.0",
      placement: "same_runtime",
      required: true,
      parentArtifactDigest: "root-a",
    }],
  });
  const second = computeSkillRolloutPlanDigestSync({
    ...base,
    closure: [{
      coordinate: "github:owner/repo/skills/dep",
      artifactDigest: "dep",
      requestedVersion: "^1.0.0",
      placement: "same_runtime",
      required: true,
      parentArtifactDigest: "root-b",
    }],
  });
  assert.notEqual(first, second, "parent anchor changes must invalidate the approved digest");
});

test("resolveSkillDependencyClosureSync rejects conflicting version ranges for the same coordinate", () => {
  buildArtifact({ name: "dep", version: "1.0.0", coordinate: "github:owner/repo/skills/dep" });
  buildArtifact({ name: "a", coordinate: "github:owner/repo/skills/a", skillDependencies: [{ coordinate: "github:owner/repo/skills/dep", version: "^1.0.0", placement: "workflow", required: true }] });
  buildArtifact({ name: "b", coordinate: "github:owner/repo/skills/b", skillDependencies: [{ coordinate: "github:owner/repo/skills/dep", version: "^2.0.0", placement: "workflow", required: true }] });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [
      { coordinate: "github:owner/repo/skills/a", version: "^1.0.0", placement: "workflow", required: true },
      { coordinate: "github:owner/repo/skills/b", version: "^1.0.0", placement: "workflow", required: true },
    ],
  });
  assert.throws(() => resolveSkillDependencyClosureSync({ rootArtifactDigest: root.digest }), /skill_dependency_conflict/);
});
