// Unit tests for the workspace-skill pg 原型 cutover runner
// (Phase 2 18 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listStoredWorkspaceSkillsSync } from "../skills.ts";
import {
  isWorkspaceSkillsAsyncReadEnabled,
} from "./workspace-skills-async.ts";
import {
  listStoredWorkspaceSkillsCutover,
  type ListWorkspaceSkillsCutoverMetric,
} from "./workspace-skills-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED;
  delete process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED;
  else process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED;
  else process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listStoredWorkspaceSkillsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isWorkspaceSkillsAsyncReadEnabled(), false);
  const metrics: ListWorkspaceSkillsCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listStoredWorkspaceSkillsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listStoredWorkspaceSkillsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED = "1";
  delete process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED;

  const metrics: ListWorkspaceSkillsCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(listStoredWorkspaceSkillsSync("default").map((r) => r.id));
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(record.id));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listStoredWorkspaceSkillsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.WORKSPACE_SKILLS_ASYNC_READ_ENABLED = "1";
  process.env.WORKSPACE_SKILLS_SHADOW_READ_ENABLED = "1";

  const metrics: ListWorkspaceSkillsCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});