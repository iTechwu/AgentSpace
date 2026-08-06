import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowFailureCode } from "./completion.ts";

test("workflow failures persist only stable non-sensitive codes", () => {
  assert.equal(normalizeWorkflowFailureCode("workflow_provider_timeout"), "workflow_provider_timeout");
  assert.equal(normalizeWorkflowFailureCode("permission denied for /private/key"), "workflow_task_failed");
  assert.equal(normalizeWorkflowFailureCode(), "workflow_task_failed");
});
