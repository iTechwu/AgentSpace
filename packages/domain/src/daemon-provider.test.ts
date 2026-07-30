import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderProtocols } from "./daemon-provider.ts";

test("Codex managed runtimes request the Responses protocol", () => {
  assert.deepEqual(resolveProviderProtocols("codex"), ["openai_response"]);
});
