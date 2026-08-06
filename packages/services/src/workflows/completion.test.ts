import assert from "node:assert/strict";
import test from "node:test";
import { getWorkflowCompletionErrorCode, normalizeWorkflowFailureCode, normalizeWorkflowNodeOutput } from "./completion.ts";

test("workflow failures persist only stable non-sensitive codes", () => {
  assert.equal(normalizeWorkflowFailureCode("workflow_provider_timeout"), "workflow_provider_timeout");
  assert.equal(normalizeWorkflowFailureCode("permission denied for /private/key"), "workflow_task_failed");
  assert.equal(normalizeWorkflowFailureCode(), "workflow_task_failed");
});

test("workflow completion exposes only stable structured output contract errors", () => {
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_output_invalid")), "workflow_output_invalid");
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_output_too_large")), "workflow_output_too_large");
  assert.equal(getWorkflowCompletionErrorCode(new Error("password=/private/key")), undefined);
});

test("workflow completion validates and persists only declared structured output fields", () => {
  assert.deepEqual(normalizeWorkflowNodeOutput({
    outputText: "fallback",
    structuredOutput: { report: "artifact://report", score: 0.9, private: "drop" },
    nodeConfigJson: '{"outputFields":["report","score"]}',
  }), { report: "artifact://report", score: 0.9 });
  assert.deepEqual(normalizeWorkflowNodeOutput({
    outputText: '{"report":"inline"}',
    nodeConfigJson: '{"outputFields":["report"]}',
  }), { report: "inline" });
  assert.throws(() => normalizeWorkflowNodeOutput({
    outputText: "not-json",
    nodeConfigJson: '{"outputFields":["report"]}',
  }), /workflow_output_invalid/);
  assert.throws(() => normalizeWorkflowNodeOutput({
    outputText: "{}",
    nodeConfigJson: '{"outputFields":["constructor"]}',
  }), /workflow_output_invalid/);
  assert.throws(() => normalizeWorkflowNodeOutput({
    outputText: JSON.stringify({ report: "x".repeat(256 * 1024) }),
    nodeConfigJson: '{"outputFields":["report"]}',
  }), /workflow_output_too_large/);
});
