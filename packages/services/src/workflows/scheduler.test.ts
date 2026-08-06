import assert from "node:assert/strict";
import test from "node:test";
import { computeNextWorkflowFireAt } from "./scheduler.ts";

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

test("rejects unbounded schedule configuration", () => {
  assert.equal(computeNextWorkflowFireAt(trigger("{}"), "2026-08-07T01:00:00.000Z", "2026-08-07T01:00:30.000Z"), null);
});
