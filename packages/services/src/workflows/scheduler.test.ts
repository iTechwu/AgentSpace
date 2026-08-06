import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextWorkflowFireAt,
  isOneTimeWorkflowTrigger,
  normalizeWorkflowTriggerForPublish,
  resolveWorkflowScheduleDecision,
  workflowSchedulerFailureDisposition,
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
      misfirePolicy: "skip",
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

test("normalizes valid event names and rejects unsafe names", () => {
  assert.equal(normalizeWorkflowTriggerForPublish({
    type: "event",
    configJson: '{"eventName":" task.completed "}',
  }).configJson, '{"eventName":"task.completed"}');
  assert.throws(() => normalizeWorkflowTriggerForPublish({
    type: "event",
    configJson: '{"eventName":"task completed"}',
  }), /workflow_event_invalid/);
});

test("rejects unbounded schedule configuration", () => {
  assert.equal(computeNextWorkflowFireAt(trigger("{}"), "2026-08-07T01:00:00.000Z", "2026-08-07T01:00:30.000Z"), null);
});

test("skip misfire advances directly to the next future occurrence", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      trigger('{"repeatSeconds":3600}'),
      "2026-08-07T04:10:00.000Z",
    ),
    {
      runScheduledAt: null,
      nextFireAt: "2026-08-07T05:00:00.000Z",
      misfired: true,
    },
  );
});

test("cron execution exactly on schedule is not treated as an invalid misfire", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      trigger('{"cronExpression":"0 9 * * 1-5"}', "Asia/Shanghai"),
      "2026-08-07T01:00:00.000Z",
    ),
    {
      runScheduledAt: "2026-08-07T01:00:00.000Z",
      nextFireAt: "2026-08-10T01:00:00.000Z",
      misfired: false,
    },
  );
});

test("fire-once misfire runs only the latest missed occurrence", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      { ...trigger('{"repeatSeconds":3600}'), misfirePolicy: "fire_once" },
      "2026-08-07T04:10:00.000Z",
    ),
    {
      runScheduledAt: "2026-08-07T04:00:00.000Z",
      nextFireAt: "2026-08-07T05:00:00.000Z",
      misfired: true,
    },
  );
});

test("fire-once cron recovery selects the latest occurrence after a long outage", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      {
        ...trigger('{"cronExpression":"0 9 * * 1-5"}', "Asia/Shanghai"),
        misfirePolicy: "fire_once",
        nextFireAt: "2026-07-01T01:00:00.000Z",
      },
      "2026-08-07T02:10:00.000Z",
    ),
    {
      runScheduledAt: "2026-08-07T01:00:00.000Z",
      nextFireAt: "2026-08-10T01:00:00.000Z",
      misfired: true,
    },
  );
});

test("fire-once cron recovery includes an occurrence exactly at recovery time", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      {
        ...trigger('{"cronExpression":"0 9 * * 1-5"}', "Asia/Shanghai"),
        misfirePolicy: "fire_once",
        nextFireAt: "2026-07-01T01:00:00.000Z",
      },
      "2026-08-07T01:00:00.000Z",
    ),
    {
      runScheduledAt: "2026-08-07T01:00:00.000Z",
      nextFireAt: "2026-08-10T01:00:00.000Z",
      misfired: true,
    },
  );
});

test("misfire grace executes a slightly delayed occurrence without historical catch-up", () => {
  assert.deepEqual(
    resolveWorkflowScheduleDecision(
      trigger('{"repeatSeconds":10,"misfireGraceSeconds":60}'),
      "2026-08-07T01:00:30.000Z",
    ),
    {
      runScheduledAt: "2026-08-07T01:00:00.000Z",
      nextFireAt: "2026-08-07T01:00:40.000Z",
      misfired: false,
    },
  );
});

test("rejects unsupported misfire policies at publish", () => {
  assert.throws(
    () => normalizeWorkflowTriggerForPublish({
      type: "schedule",
      configJson: '{"repeatSeconds":3600}',
      misfirePolicy: "catch_all" as never,
    }),
    /workflow_misfire_policy_invalid/,
  );
});

test("scheduler failures distinguish stale claims, deterministic defects and transient retries", () => {
  assert.equal(workflowSchedulerFailureDisposition(new Error("workflow_definition_not_published")), "stale");
  assert.equal(workflowSchedulerFailureDisposition(new Error("workflow_trigger_lease_conflict")), "stale");
  assert.equal(workflowSchedulerFailureDisposition(new Error("workflow_active_version_missing")), "suspend");
  assert.equal(workflowSchedulerFailureDisposition(new SyntaxError("bad graph")), "suspend");
  assert.equal(workflowSchedulerFailureDisposition(new Error("connection reset")), "retry");
});
