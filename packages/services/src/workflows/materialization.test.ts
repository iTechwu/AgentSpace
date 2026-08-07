import assert from "node:assert/strict";
import test from "node:test";
import { assertManualWorkflowTriggerAvailable } from "./materialization.ts";

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
