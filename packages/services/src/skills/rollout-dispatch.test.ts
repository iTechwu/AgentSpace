import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { getDatabase, randomLikeId, readSkillRolloutPlanSync } from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  installSkillRolloutSync,
  resetWorkspaceStateSync,
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

function createRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`
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
    files: [{ path: "SKILL.md", bytes: encoder.encode(`---\nname: ${input.name}\n---\n# Body\n`) }],
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo",
    coordinate: input.coordinate,
    ...(input.skillDependencies ? { skillDependencies: input.skillDependencies } : {}),
  });
}

test("installSkillRolloutSync dispatches root + closure in one operation and consumes the plan", () => {
  const runtimeId = createRuntime();
  buildArtifact({ name: "dep1", version: "1.0.0", coordinate: "github:owner/repo/skills/dep1" });
  buildArtifact({ name: "dep2", version: "1.0.0", coordinate: "github:owner/repo/skills/dep2" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [
      { coordinate: "github:owner/repo/skills/dep1", version: "^1.0.0", placement: "workflow", required: true },
      { coordinate: "github:owner/repo/skills/dep2", version: "^1.0.0", placement: "same_runtime", required: true },
    ],
  });

  const result = installSkillRolloutSync({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
  });

  assert.equal(result.createdCount, 3, "root + 2 deps dispatched");
  assert.equal(result.totalItems, 3);
  assert.equal(result.reusedCount, 0);
  assert.equal(result.planDigest.length, 64);

  const plan = readSkillRolloutPlanSync(result.planId, "default");
  assert.equal(plan?.decision, "approved");
  assert.equal(typeof plan?.consumedAt, "string", "plan consumed after dispatch");
});

test("installSkillRolloutSync reuses in-flight items and creates a fresh plan on re-run", () => {
  const runtimeId = createRuntime();
  buildArtifact({ name: "dep", version: "1.0.0", coordinate: "github:owner/repo/skills/dep" });
  const root = buildArtifact({
    name: "root",
    coordinate: "github:owner/repo/skills/root",
    skillDependencies: [{ coordinate: "github:owner/repo/skills/dep", version: "^1.0.0", placement: "workflow", required: true }],
  });

  const first = installSkillRolloutSync({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
  });
  assert.equal(first.createdCount, 2);

  const second = installSkillRolloutSync({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
  });
  assert.equal(second.createdCount, 0, "in-flight items are reused, not recreated");
  assert.equal(second.reusedCount, 2);
  assert.notEqual(second.planId, first.planId, "a fresh plan (re-approval) each run");
});
