import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowTriggerRecord } from "@dofe-agent/db";

import {
  assertManualWorkflowTriggerAvailable,
  assertWorkflowTriggerCanMaterialize,
  buildWorkflowEmployeeNameSnapshots,
} from "./materialization.ts";

function trigger(overrides: Partial<WorkflowTriggerRecord> = {}): WorkflowTriggerRecord {
  return {
    id: "trigger-1",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    type: "schedule" as const,
    configJson: '{"repeatSeconds":60}',
    timezone: "UTC",
    status: "active",
    misfirePolicy: "skip" as const,
    dedupeWindowSeconds: 0,
    nextFireAt: "2026-08-07T00:00:00.000Z",
    leaseOwner: "scheduler-1",
    leaseExpiresAt: "2026-08-07T00:01:00.000Z",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

test("workflow node snapshots preserve the employee display name instead of the stable id", () => {
  const snapshots = buildWorkflowEmployeeNameSnapshots([
    { id: "employee-1", name: "Atlas", remarkName: "研究员 Atlas" },
    { id: "employee-2", name: "Nova", remarkName: "  " },
  ]);

  assert.equal(snapshots.get("employee-1"), "研究员 Atlas");
  assert.equal(snapshots.get("employee-2"), "Nova");
  assert.equal(snapshots.has("Atlas"), false);
});

test("materialization fences a schedule claim by its exact lease", () => {
  const claimed = trigger();
  assert.doesNotThrow(() => assertWorkflowTriggerCanMaterialize(claimed, trigger()));
  assert.throws(
    () => assertWorkflowTriggerCanMaterialize(claimed, trigger({ leaseOwner: "scheduler-2" })),
    /workflow_trigger_lease_conflict/,
  );
});

test("materialization rejects stale event snapshots after trigger edits", () => {
  const claimed = trigger({ type: "event", configJson: '{"eventName":"task.created"}', leaseOwner: undefined, leaseExpiresAt: undefined });
  assert.doesNotThrow(() => assertWorkflowTriggerCanMaterialize(claimed, { ...claimed }));
  assert.throws(
    () => assertWorkflowTriggerCanMaterialize(claimed, { ...claimed, configJson: '{"eventName":"task.deleted"}', updatedAt: "2026-08-07T00:01:00.000Z" }),
    /workflow_trigger_stale_snapshot/,
  );
});

test("manual materialization requires the published active trigger to be manual", () => {
  assert.doesNotThrow(() => assertManualWorkflowTriggerAvailable("published", { type: "manual", status: "active" }));
  assert.throws(
    () => assertManualWorkflowTriggerAvailable("published", { type: "schedule", status: "active" }),
    /workflow_manual_trigger_required/,
  );
  assert.throws(
    () => assertManualWorkflowTriggerAvailable("published", { type: "manual", status: "suspended" }),
    /workflow_manual_trigger_required/,
  );
  assert.throws(
    () => assertManualWorkflowTriggerAvailable("paused", { type: "manual", status: "active" }),
    /workflow_definition_not_published/,
  );
});
