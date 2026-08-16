import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  decideSkillRolloutPlanSync,
  getDatabase,
  listSkillRolloutReconcileItemsSync,
  randomLikeId,
  readSkillRolloutPlanSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  installSkillRolloutSync,
  reconcileSkillRolloutPlanSync,
  SkillRolloutDispatchError,
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
  assert.equal(result.plan.planId, result.planId);
  assert.equal(result.plan.planDigest, result.planDigest);

  const plan = readSkillRolloutPlanSync(result.planId, "default");
  assert.equal(plan?.decision, "approved");
  assert.equal(typeof plan?.consumedAt, "string", "plan consumed after dispatch");
});

test("SkillRolloutDispatchError preserves reconcile context", () => {
  const error = new SkillRolloutDispatchError({
    planId: "plan-1",
    planDigest: "digest-1",
    createdInstallations: [{
      runtimeId: "runtime-1",
      artifactDigest: "artifact-1",
      installationId: "installation-1",
      revision: "v1",
    }],
    cause: new Error("child failed"),
  });
  assert.equal(error.name, "SkillRolloutDispatchError");
  assert.equal(error.planId, "plan-1");
  assert.equal(error.planDigest, "digest-1");
  assert.equal(error.createdInstallations.length, 1);
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
  assert.equal(second.plan.planDigest, second.planDigest);
});

test("reconcile persists a failed item and retries it to a consumed plan", () => {
  const runtimeId = createRuntime();
  const root = buildArtifact({ name: "reconcile-root", coordinate: "github:owner/repo/skills/reconcile-root" });
  const pending = installSkillRolloutSync({
    rootArtifactDigest: root.digest,
    targetScope: { kind: "runtimes", runtimeIds: [runtimeId] },
    approve: false,
  });
  assert.equal(decideSkillRolloutPlanSync(pending.planId, "default", "approved"), true);
  getDatabase().prepare("UPDATE agent_runtime SET status = 'offline' WHERE id = ?").run(runtimeId);

  assert.throws(
    () => reconcileSkillRolloutPlanSync({ planId: pending.planId }),
    (error: unknown) => error instanceof SkillRolloutDispatchError,
  );
  const failed = listSkillRolloutReconcileItemsSync(pending.planId, "default");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.status, "failed");
  assert.equal(failed[0]?.attemptCount, 1);

  getDatabase().prepare("UPDATE agent_runtime SET status = 'online' WHERE id = ?").run(runtimeId);
  const retried = reconcileSkillRolloutPlanSync({ planId: pending.planId });
  assert.equal(retried.consumed, true);
  assert.equal(retried.items[0]?.status, "created");
  assert.equal(retried.items[0]?.attemptCount, 2);
  assert.equal(typeof readSkillRolloutPlanSync(pending.planId, "default")?.consumedAt, "string");

  const repeated = reconcileSkillRolloutPlanSync({ planId: pending.planId });
  assert.equal(repeated.consumed, true);
  assert.equal(repeated.createdInstallations.length, 0);
  assert.equal(repeated.reusedCount, 1);
});
