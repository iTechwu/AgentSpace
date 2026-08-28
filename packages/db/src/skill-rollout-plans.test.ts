import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";
import {
  createSkillRolloutPlanSync,
  readSkillRolloutPlanSync,
  readSkillRolloutPlanByDigestSync,
  decideSkillRolloutPlanSync,
  consumeSkillRolloutPlanSync,
} from "./index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM skill_rollout_plan").run();
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(DEFAULT_WORKSPACE_ID, "default", "test", now, now);
  });
});

function planInput(overrides: Partial<Parameters<typeof createSkillRolloutPlanSync>[0]> = {}) {
  return {
    workspaceId: "default",
    rootArtifactDigest: "root-digest",
    planDigest: "plan-digest-1",
    closureJson: JSON.stringify([]),
    targetRuntimesJson: JSON.stringify([]),
    riskSummaryJson: JSON.stringify([]),
    ...overrides,
  };
}

test("creates, reads, decides and consumes a rollout plan", () => {
  const plan = createSkillRolloutPlanSync(planInput());
  assert.ok(plan.id.startsWith("srp-"));
  assert.equal(plan.decision, "pending");
  assert.equal(plan.consumedAt, undefined);

  assert.equal(decideSkillRolloutPlanSync(plan.id, "default", "approved"), true);
  assert.equal(readSkillRolloutPlanSync(plan.id, "default")?.decision, "approved");

  assert.equal(consumeSkillRolloutPlanSync(plan.id, "default"), true);
  assert.equal(typeof readSkillRolloutPlanSync(plan.id, "default")?.consumedAt, "string");
});

test("re-creating the same digest creates a fresh plan so it can be re-approved", () => {
  const first = createSkillRolloutPlanSync(planInput());
  decideSkillRolloutPlanSync(first.id, "default", "approved");
  consumeSkillRolloutPlanSync(first.id, "default");

  const second = createSkillRolloutPlanSync(planInput());
  assert.notEqual(second.id, first.id);
  assert.equal(second.decision, "pending");
  assert.equal(second.consumedAt, undefined);
});

test("consume is one-time and only for approved plans", () => {
  const plan = createSkillRolloutPlanSync(planInput());
  assert.equal(consumeSkillRolloutPlanSync(plan.id, "default"), false, "pending plan is not consumable");
  decideSkillRolloutPlanSync(plan.id, "default", "approved");
  assert.equal(consumeSkillRolloutPlanSync(plan.id, "default"), true);
  assert.equal(consumeSkillRolloutPlanSync(plan.id, "default"), false, "already consumed");
});

test("readSkillRolloutPlanByDigestSync returns the latest plan for a digest", () => {
  const first = createSkillRolloutPlanSync(planInput());
  const second = createSkillRolloutPlanSync(planInput());
  const latest = readSkillRolloutPlanByDigestSync({ workspaceId: "default", planDigest: "plan-digest-1" });
  assert.equal(latest?.id, second.id);
});
