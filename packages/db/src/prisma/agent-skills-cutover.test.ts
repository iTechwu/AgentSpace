// Unit tests for the agent-skill pg 原型 cutover runner (Phase 2 7 域).

import assert from "node:assert/strict";
import test from "node:test";
import { listStoredAgentSkillAssignmentsSync } from "../skills.ts";
import {
  isAgentSkillsAsyncReadEnabled,
} from "./agent-skills-async.ts";
import {
  listAgentSkillAssignmentsCutover,
  type ListAgentSkillsCutoverMetric,
} from "./agent-skills-cutover.ts";

const ORIGINAL_ASYNC = process.env.AGENT_SKILLS_ASYNC_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AGENT_SKILLS_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AGENT_SKILLS_ASYNC_READ_ENABLED;
  delete process.env.AGENT_SKILLS_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_ASYNC === undefined) delete process.env.AGENT_SKILLS_ASYNC_READ_ENABLED;
  else process.env.AGENT_SKILLS_ASYNC_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AGENT_SKILLS_SHADOW_READ_ENABLED;
  else process.env.AGENT_SKILLS_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

test("listAgentSkillAssignmentsCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  assert.equal(isAgentSkillsAsyncReadEnabled(), false);
  const metrics: ListAgentSkillsCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, listStoredAgentSkillAssignmentsSync("default"));
  assert.equal(metrics.length, 0);
});

test("listAgentSkillAssignmentsCutover returns rows with flag on (shadow off)", async () => {
  resetFlags();
  process.env.AGENT_SKILLS_ASYNC_READ_ENABLED = "1";
  delete process.env.AGENT_SKILLS_SHADOW_READ_ENABLED;

  const metrics: ListAgentSkillsCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  const syncIds = new Set(
    listStoredAgentSkillAssignmentsSync("default").map((r) => `${r.employeeId}:${r.skillId}`),
  );
  assert.equal(result.length, syncIds.size);
  for (const record of result) {
    assert.ok(syncIds.has(`${record.employeeId}:${record.skillId}`));
  }
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0]!.source === "primary" || metrics[0]!.source === "fallback");
});

test("listAgentSkillAssignmentsCutover emits metric under shadow flag", async () => {
  resetFlags();
  process.env.AGENT_SKILLS_ASYNC_READ_ENABLED = "1";
  process.env.AGENT_SKILLS_SHADOW_READ_ENABLED = "1";

  const metrics: ListAgentSkillsCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.ok(metrics.length >= 1);
  for (const m of metrics) {
    assert.equal(typeof m.durationMs, "number");
  }
});