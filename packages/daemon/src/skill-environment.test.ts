import assert from "node:assert/strict";
import test from "node:test";
import { partitionSkillEnvironment } from "./skill-environment.ts";

test("partitionSkillEnvironment keeps declared Runner configuration out of Provider env", () => {
  const partitioned = partitionSkillEnvironment({
    RENDER_TOKEN: "runner-secret",
    LEGACY_REGION: "cn-north-1",
    UNUSED_SECRET: "not-declared",
  }, [{ configKeys: ["RENDER_TOKEN"] }]);

  assert.deepEqual(partitioned.runnerEnv, { RENDER_TOKEN: "runner-secret" });
  assert.deepEqual(partitioned.providerEnv, {
    LEGACY_REGION: "cn-north-1",
    UNUSED_SECRET: "not-declared",
  });
});

test("partitionSkillEnvironment does not expose undeclared values to Runner", () => {
  const partitioned = partitionSkillEnvironment({
    REQUIRED_TOKEN: "allowed",
    EXTRA_TOKEN: "denied",
  }, [{ configKeys: ["REQUIRED_TOKEN", "MISSING_TOKEN"] }]);

  assert.deepEqual(partitioned.runnerEnv, { REQUIRED_TOKEN: "allowed" });
  assert.deepEqual(partitioned.providerEnv, { EXTRA_TOKEN: "denied" });
});
