import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderDefaultModel, resolveProviderProtocols } from "./daemon-provider.ts";

test("Codex managed runtimes request the Responses protocol", () => {
  assert.deepEqual(resolveProviderProtocols("codex"), ["openai_response"]);
});

test("Codex managed runtimes default to the verified Terra model", () => {
  assert.equal(resolveProviderDefaultModel("codex"), "gpt-5.6-terra");
  assert.equal(resolveProviderDefaultModel("claude"), undefined);
});

test("DeepSeek Harness managed runtimes use the native protocol and Flash default", () => {
  assert.deepEqual(resolveProviderProtocols("deepseek-harness"), ["deepseek_native"]);
  assert.equal(resolveProviderDefaultModel("deepseek-harness"), "deepseek-v4-flash");
});
