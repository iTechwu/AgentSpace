import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskCompletionTokenUsage } from "./task-completion-token-usage.ts";

test("buildTaskCompletionTokenUsage supplies a stable task completion idempotency key", () => {
  assert.deepEqual(buildTaskCompletionTokenUsage({
    taskId: "task-1",
    modelId: " gpt-5 ",
    inputTokens: 10,
    outputTokens: 2,
    runtimeCredentialId: "credential-1",
  }), {
    modelId: "gpt-5",
    inputTokens: 10,
    outputTokens: 2,
    gatewayRequestId: "task:task-1:completion",
    runtimeCredentialId: "credential-1",
  });
});

test("buildTaskCompletionTokenUsage rejects empty and invalid usage", () => {
  assert.equal(buildTaskCompletionTokenUsage({ taskId: "task-1", modelId: "gpt-5", inputTokens: 0, outputTokens: 0 }), undefined);
  assert.equal(buildTaskCompletionTokenUsage({ taskId: "task-1", modelId: "gpt-5", inputTokens: -1, outputTokens: 2 }), undefined);
  assert.equal(buildTaskCompletionTokenUsage({ taskId: "task-1", modelId: "gpt-5", inputTokens: 1.5, outputTokens: 2 }), undefined);
});
