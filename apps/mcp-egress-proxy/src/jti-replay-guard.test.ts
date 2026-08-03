import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJtiReplayGuard } from "./jti-replay-guard.ts";

test("JTI binds to one proxy session until expiration", () => {
  const guard = new InMemoryJtiReplayGuard();
  assert.equal(guard.bind("jti-1", "session-a", 110, 100), true);
  assert.equal(guard.bind("jti-1", "session-a", 110, 100), true);
  assert.equal(guard.bind("jti-1", "session-b", 110, 100), false);
  assert.equal(guard.bind("jti-1", "session-b", 120, 110), true);
});

test("JTI without a proxy session remains one-shot", () => {
  const guard = new InMemoryJtiReplayGuard();
  assert.equal(guard.bind("jti-1", undefined, 110, 100), true);
  assert.equal(guard.bind("jti-1", undefined, 110, 100), false);
});
