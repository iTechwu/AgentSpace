import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import {
  initializeSkillRolloutReconcileItemsSync,
  listSkillRolloutReconcileItemsSync,
  markSkillRolloutReconcileItemSync,
} from "./skill-rollout-reconcile.ts";

beforeEach(() => {
  getDatabase().prepare("DELETE FROM skill_rollout_reconcile_item").run();
});

test("reconcile items persist pending, failed, and created transitions idempotently", () => {
  const now = new Date().toISOString();
  const planId = `plan-reconcile-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO skill_rollout_plan (
      id, workspace_id, root_artifact_digest, plan_digest, policy_version,
      closure_json, target_runtimes_json, risk_summary_json, decision, created_at
    ) VALUES (?, ?, ?, ?, 'v1', '[]', '[]', '[]', 'approved', ?)`,
  ).run(planId, DEFAULT_WORKSPACE_ID, `root-${randomLikeId()}`, `digest-${randomLikeId()}`, now);
  const items = initializeSkillRolloutReconcileItemsSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    planId,
    items: [{ runtimeId: "runtime-1", artifactDigest: "artifact-1" }],
  });
  assert.equal(items[0]?.status, "pending");
  assert.equal(items[0]?.attemptCount, 0);

  const failed = markSkillRolloutReconcileItemSync({
    id: items[0]!.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    status: "failed",
    errorCode: "runtime.offline",
  });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attemptCount, 1);
  assert.equal(failed?.errorCode, "runtime.offline");

  const created = markSkillRolloutReconcileItemSync({
    id: items[0]!.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    status: "created",
    installationId: "installation-1",
    revision: "v1",
  });
  assert.equal(created?.status, "created");
  assert.equal(created?.attemptCount, 2);
  assert.equal(created?.installationId, "installation-1");

  const terminal = markSkillRolloutReconcileItemSync({
    id: items[0]!.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    status: "failed",
    errorCode: "must_not_overwrite_created",
  });
  assert.equal(terminal?.status, "created", "created is a terminal reconcile state");
  assert.equal(terminal?.attemptCount, 2);

  const repeated = initializeSkillRolloutReconcileItemsSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    planId,
    items: [{ runtimeId: "runtime-1", artifactDigest: "artifact-1" }],
  });
  assert.equal(repeated[0]?.status, "created", "re-initialization must not reset a completed item");
  assert.equal(listSkillRolloutReconcileItemsSync(planId).length, 1);
});
