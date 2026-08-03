import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SingleReplicaJtiReplayGuard } from "./jti-replay-guard.ts";

test("JTI binds to one proxy session until expiration", () => {
  const guard = new SingleReplicaJtiReplayGuard();
  assert.equal(guard.bind("jti-1", "session-a", 110, 100), true);
  assert.equal(guard.bind("jti-1", "session-a", 110, 100), true);
  assert.equal(guard.bind("jti-1", "session-b", 110, 100), false);
  assert.equal(guard.bind("jti-1", "session-b", 120, 110), true);
});

test("JTI without a proxy session remains one-shot", () => {
  const guard = new SingleReplicaJtiReplayGuard();
  assert.equal(guard.bind("jti-1", undefined, 110, 100), true);
  assert.equal(guard.bind("jti-1", undefined, 110, 100), false);
});

test("JTI session binding survives a proxy restart when stateFile is configured", () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "dofe-egress-jti-")), "bindings.json");
  const first = new SingleReplicaJtiReplayGuard({ stateFile });
  assert.equal(first.bind("jti-1", "session-a", 120, 100), true);

  const restarted = new SingleReplicaJtiReplayGuard({ stateFile });
  assert.equal(restarted.bind("jti-1", "session-b", 120, 100), false);
  assert.equal(restarted.bind("jti-1", "session-a", 120, 100), true);
});

test("corrupt JTI state fails proxy startup instead of losing replay protection", () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "dofe-egress-jti-corrupt-")), "bindings.json");
  writeFileSync(stateFile, "{", "utf8");
  assert.throws(() => new SingleReplicaJtiReplayGuard({ stateFile }), /state file is unreadable/);
});
