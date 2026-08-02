import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJtiReplayGuard } from "./jti-replay-guard.ts";

test("JTI consumption is one-shot until expiration", () => {
  const guard = new InMemoryJtiReplayGuard();
  assert.equal(guard.consume("jti-1", 110, 100), true);
  assert.equal(guard.consume("jti-1", 110, 100), false);
  assert.equal(guard.consume("jti-1", 120, 110), true);
});
