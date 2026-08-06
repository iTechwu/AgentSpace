import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextWorkflowFireAt,
  isOneTimeWorkflowTrigger,
  normalizeWorkflowTriggerForPublish,
} from "./scheduler.ts";

function trigger(configJson: string, timezone = "UTC") {
  return {
    id: "trigger-1",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    type: "schedule" as const,
    configJson,
    timezone,
    status: "active",
    misfirePolicy: "skip",
    dedupeWindowSeconds: 0,
    nextFireAt: "2026-08-07T01:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("advances repeat schedules by configured seconds", () => {
  assert.equal(
    computeNextWorkflowFireAt(trigger('{"repeatSeconds":3600}'), "2026-08-07T01:00:00.000Z", "2026-08-07T01:00:30.000Z"),
    "2026-08-07T02:00:00.000Z",
  );
});

test("computes daily schedules in the trigger timezone", () => {
  assert.equal(
    computeNextWorkflowFireAt(
      trigger('{"dailyAt":"09:30"}', "Asia/Shanghai"),
      "2026-08-07T01:00:00.000Z",
      "2026-08-07T01:00:30.000Z",
    ),
    "2026-08-08T01:30:00.000Z",
  );
});

test("computes cron schedules in the trigger timezone", () => {
  assert.equal(
    computeNextWorkflowFireAt(
      trigger('{"cronExpression":"0 9 * * 1-5"}', "Asia/Shanghai"),
      "2026-08-06T01:00:00.000Z",
      "2026-08-06T01:00:30.000Z",
    ),
    "2026-08-07T01:00:00.000Z",
  );
});

test("normalizes the first cron fire time on publish", () => {
  assert.deepEqual(
    normalizeWorkflowTriggerForPublish({
      type: "schedule",
      configJson: '{"cronExpression":"0 9 * * 1-5"}',
      timezone: "Asia/Shanghai",
    }, "2026-08-06T00:00:00.000Z"),
    {
      type: "schedule",
      configJson: '{"cronExpression":"0 9 * * 1-5"}',
      timezone: "Asia/Shanghai",
      nextFireAt: "2026-08-06T01:00:00.000Z",
    },
  );
});

test("normalizes a future one-time fire and marks it complete after firing", () => {
  const normalized = normalizeWorkflowTriggerForPublish({
    type: "schedule",
    configJson: '{"onceAt":"2026-08-08T03:00:00.000Z"}',
    timezone: "Asia/Shanghai",
  }, "2026-08-06T00:00:00.000Z");
  assert.equal(normalized.nextFireAt, "2026-08-08T03:00:00.000Z");
  assert.equal(isOneTimeWorkflowTrigger(trigger(normalized.configJson, normalized.timezone)), true);
  assert.equal(
    computeNextWorkflowFireAt(trigger(normalized.configJson, normalized.timezone), normalized.nextFireAt!, "2026-08-08T03:00:00.000Z"),
    null,
  );
});

test("rejects invalid cron and past one-time schedules", () => {
  assert.throws(
    () => normalizeWorkflowTriggerForPublish({
      type: "schedule",
      configJson: '{"cronExpression":"not-a-cron"}',
      timezone: "Asia/Shanghai",
    }, "2026-08-06T00:00:00.000Z"),
    /workflow_schedule_invalid/,
  );
  assert.throws(
    () => normalizeWorkflowTriggerForPublish({
      type: "schedule",
      configJson: '{"onceAt":"2026-08-05T03:00:00.000Z"}',
      timezone: "Asia/Shanghai",
    }, "2026-08-06T00:00:00.000Z"),
    /workflow_schedule_in_past/,
  );
});

test("rejects unbounded schedule configuration", () => {
  assert.equal(computeNextWorkflowFireAt(trigger("{}"), "2026-08-07T01:00:00.000Z", "2026-08-07T01:00:30.000Z"), null);
});
