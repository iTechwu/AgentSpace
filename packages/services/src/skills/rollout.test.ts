import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  computeSkillRolloutTargetRuntimesSync,
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

function createRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Runtime ${id}`, now, now);
  return id;
}

function buildArtifact(input: {
  name: string;
  version?: string;
  coordinate?: string;
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
