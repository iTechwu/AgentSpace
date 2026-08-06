import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTriggerWriteOwnerSync,
  readWorkflowCutoverModeSync,
  resolveTriggerOwner,
  shouldReadLegacyWorkflowSources,
  type WorkflowCutoverMode,
} from "./feature-flags.ts";

test("legacy-only, dual-read, engine and archived modes select one trigger owner", () => {
  const expectations: Array<[WorkflowCutoverMode, "legacy" | "workflow"]> = [
    ["legacy_only", "legacy"],
    ["dual_read", "workflow"],
    ["workflow_engine", "workflow"],
    ["legacy_archived", "workflow"],
  ];
  for (const [mode, owner] of expectations) {
    assert.equal(resolveTriggerOwner({ mode }), owner);
  }
});

test("resolves workspace overrides without letting malformed flags change the safe default", () => {
  const env = {
    WORKFLOW_CUTOVER_MODE: "dual_read",
    WORKFLOW_CUTOVER_MODES: JSON.stringify({ "workspace-a": "workflow_engine", "workspace-b": "invalid" }),
  };
  assert.equal(readWorkflowCutoverModeSync("workspace-a", env), "workflow_engine");
  assert.equal(readWorkflowCutoverModeSync("workspace-b", env), "dual_read");
  assert.equal(readWorkflowCutoverModeSync("workspace-c", {}), "legacy_only");
});

test("dual-read rejects legacy trigger writes and keeps legacy reads", () => {
  const env = { WORKFLOW_CUTOVER_MODE: "dual_read" };
  assert.throws(() => assertTriggerWriteOwnerSync("workspace-a", "calendar", env), /workflow_trigger_owner_conflict/);
  assert.doesNotThrow(() => assertTriggerWriteOwnerSync("workspace-a", "workflow", env));
  assert.equal(shouldReadLegacyWorkflowSources("dual_read"), true);
  assert.equal(shouldReadLegacyWorkflowSources("legacy_archived"), false);
});
