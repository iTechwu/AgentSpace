import assert from "node:assert/strict";
import test from "node:test";
import { buildDomainCutover } from "./cutover-runner.ts";

test("domain cutover keeps the default sink and redacts caller metrics", async () => {
  const defaultErrors: Array<string | undefined> = [];
  const callerErrors: Array<string | undefined> = [];
  const read = buildDomainCutover<void, string>({
    isEnabled: () => true,
    isShadowEnabled: () => false,
    runPrimary: async () => {
      throw new Error("postgres://user:secret@example/db");
    },
    runFallback: () => "legacy",
    compare: (primary, fallback) => primary === fallback,
    emitMetric: (metric) => defaultErrors.push(metric.error),
  });

  assert.equal(await read(undefined, (metric) => callerErrors.push(metric.error)), "legacy");
  assert.deepEqual(defaultErrors, ["postgres://user:secret@example/db"]);
  assert.deepEqual(callerErrors, ["present"]);
});
