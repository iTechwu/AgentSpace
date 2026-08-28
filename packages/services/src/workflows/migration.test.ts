import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinitionRecord, WorkflowTriggerRecord } from "@dofe-agent/db";
import type { ScheduledTask } from "@dofe-agent/domain/workspace";
import { projectLegacySchedulesForCutover } from "./migration.ts";

const legacy: ScheduledTask = {
  id: "st-1",
  title: "Legacy daily brief",
  description: "Prepare the brief",
  assignee: "Atlas",
  repeat: "daily",
  scheduledAt: "2026-08-07T01:00:00.000Z",
  status: "active",
  createdBy: "user-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const workflow: WorkflowDefinitionRecord = {
  id: "wf-1",
  workspaceId: "default",
  name: "Daily brief",
  ownerUserId: "user-1",
  status: "published",
  draftGraphJson: JSON.stringify({ schemaVersion: 1, nodes: [{ id: "a", type: "employee_task", employeeId: "emp-atlas", config: {} }], edges: [] }),
  draftVersion: 1,
  activeVersionId: "version-1",
  legacySourceType: "scheduled_task",
  legacySourceId: "st-1",
  createdBy: "system:workflow-migration",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};
const trigger: WorkflowTriggerRecord = {
  id: "trigger-1",
  workspaceId: "default",
  workflowId: "wf-1",
  type: "schedule",
  configJson: '{"dailyAt":"09:00"}',
  status: "active",
  nextFireAt: "2026-08-08T01:00:00.000Z",
  misfirePolicy: "skip",
  dedupeWindowSeconds: 60,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

test("dual-read shows one workflow row for a migrated scheduled task", () => {
  const result = projectLegacySchedulesForCutover({ mode: "dual_read", legacyTasks: [legacy], workflows: [workflow], triggers: [trigger] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "wf-1");
  assert.equal(result[0]?.legacySourceId, "st-1");
  assert.equal(result[0]?.sourceKind, "workflow");
});

test("dual-read labels unmigrated legacy rows and archived mode hides them", () => {
  const dual = projectLegacySchedulesForCutover({ mode: "dual_read", legacyTasks: [legacy], workflows: [], triggers: [] });
  assert.equal(dual[0]?.migrationStatus, "needs_migration");
  const archived = projectLegacySchedulesForCutover({ mode: "legacy_archived", legacyTasks: [legacy], workflows: [], triggers: [] });
  assert.deepEqual(archived, []);
});
