import assert from "node:assert/strict";
import test from "node:test";
import { getWorkflowCompletionErrorCode, isWorkflowTaskCallbackIgnored, isWorkflowTaskCommitReplaySafe, isWorkflowTaskInputAvailable, isWorkflowTaskStartBlocked, normalizeWorkflowFailureCode, normalizeWorkflowNodeOutput, resolveWorkflowCompletionFailureCode } from "./completion.ts";

test("workflow failures persist only stable non-sensitive codes", () => {
  assert.equal(normalizeWorkflowFailureCode("workflow_provider_timeout"), "workflow_provider_timeout");
  assert.equal(normalizeWorkflowFailureCode("permission denied for /private/key"), "workflow_task_failed");
  assert.equal(normalizeWorkflowFailureCode(), "workflow_task_failed");
});

test("workflow completion exposes only stable structured output contract errors", () => {
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_output_invalid")), "workflow_output_invalid");
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_output_too_large")), "workflow_output_too_large");
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_completion_effect_uncertain")), "workflow_completion_effect_uncertain");
  assert.equal(getWorkflowCompletionErrorCode(new Error("workflow_commit_snapshot_missing")), "workflow_completion_effect_uncertain");
  assert.equal(getWorkflowCompletionErrorCode(new Error("password=/private/key")), undefined);
});

test("partial completion effects always require manual compensation", () => {
  assert.equal(resolveWorkflowCompletionFailureCode({
    commitBoundaryCrossed: true,
    effectsCheckpointed: false,
    errorCode: "workflow_provider_timeout",
  }), "workflow_completion_effect_uncertain");
  assert.equal(resolveWorkflowCompletionFailureCode({
    commitBoundaryCrossed: true,
    effectsCheckpointed: true,
    errorCode: "workflow_provider_timeout",
  }), "workflow_provider_timeout");
  assert.equal(resolveWorkflowCompletionFailureCode({
    commitBoundaryCrossed: false,
    effectsCheckpointed: false,
    errorCode: "workflow_output_invalid",
  }), "workflow_output_invalid");
});

test("workflow task start is fenced by paused, terminal, and non-queued runtime state", () => {
  assert.equal(isWorkflowTaskStartBlocked("paused", "queued", "queued"), true);
  assert.equal(isWorkflowTaskStartBlocked("paused", "queued", "claimed"), false);
  assert.equal(isWorkflowTaskStartBlocked("cancelled", "queued", "claimed"), true);
  assert.equal(isWorkflowTaskStartBlocked("succeeded", "queued", "claimed"), true);
  assert.equal(isWorkflowTaskStartBlocked("queued", "retry_wait", "claimed"), true);
  assert.equal(isWorkflowTaskStartBlocked("queued", "queued", "claimed"), false);
  assert.equal(isWorkflowTaskStartBlocked("waiting_approval", "queued", "claimed"), false);
});

test("workflow input remains available to in-flight work while dispatch is paused", () => {
  assert.equal(isWorkflowTaskInputAvailable("paused", "running", "running"), true);
  assert.equal(isWorkflowTaskInputAvailable("paused", "queued", "claimed"), true);
  assert.equal(isWorkflowTaskInputAvailable("paused", "queued", "queued"), false);
  assert.equal(isWorkflowTaskInputAvailable("cancelled", "running", "running"), false);
  assert.equal(isWorkflowTaskInputAvailable("running", "running", "running"), true);
});

test("a durable effects snapshot closes the journal update crash gap", () => {
  assert.equal(isWorkflowTaskCommitReplaySafe({
    journalState: "preparing",
    journalErrorCode: "workflow_completion_effects_pending",
    completionEffectsCheckpointed: true,
  }), true);
  assert.equal(isWorkflowTaskCommitReplaySafe({
    journalState: "preparing",
    journalErrorCode: "workflow_completion_effects_pending",
    completionEffectsCheckpointed: false,
  }), false);
  assert.equal(isWorkflowTaskCommitReplaySafe({
    journalState: "committed",
    journalErrorCode: "workflow_completion_effects_checkpointed",
    completionEffectsCheckpointed: true,
  }), false);
});

test("late callbacks cannot overtake a task that crossed the commit boundary", () => {
  assert.equal(isWorkflowTaskCallbackIgnored("preparing_commit"), true);
  assert.equal(isWorkflowTaskCallbackIgnored("committed"), true);
  assert.equal(isWorkflowTaskCallbackIgnored("preparing_commit", { allowPreparingCommit: true }), false);
  assert.equal(isWorkflowTaskCallbackIgnored("committed", { allowCommitted: true }), false);
  assert.equal(isWorkflowTaskCallbackIgnored("committed", { allowPreparingCommit: true }), true);
  assert.equal(isWorkflowTaskCallbackIgnored("cancelled", { allowPreparingCommit: true, allowCommitted: true }), true);
  assert.equal(isWorkflowTaskCallbackIgnored("running"), false);
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
