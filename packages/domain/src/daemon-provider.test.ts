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
