import assert from "node:assert/strict";
import test from "node:test";
import { runLaunchPlan } from "./subprocess.ts";

test("runLaunchPlan terminates an active provider process when aborted", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const resultPromise = runLaunchPlan("codex", {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 30_000,
    redactions: [],
  }, { signal: controller.signal });

  setTimeout(() => controller.abort(), 50);
  const result = await resultPromise;

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("runLaunchPlan escalates to SIGKILL when a provider ignores SIGTERM", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const resultPromise = runLaunchPlan("deepseek-harness", {
    executable: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 30_000,
    redactions: [],
  }, { signal: controller.signal });

  setTimeout(() => controller.abort(), 50);
  const result = await resultPromise;

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - startedAt >= 5_000);
  assert.ok(Date.now() - startedAt < 7_000);
});
