import assert from "node:assert/strict";
import test from "node:test";
import { percentile95, validatePrismaPoolLoadTestDatabaseUrl } from "./pool-capacity-loadtest.ts";

test("pool loadtest accepts only explicitly isolated database names", () => {
  assert.equal(
    validatePrismaPoolLoadTestDatabaseUrl("postgresql://user:pass@localhost:5432/agentspace_test"),
    "postgresql://user:pass@localhost:5432/agentspace_test",
  );
  assert.throws(
    () => validatePrismaPoolLoadTestDatabaseUrl("postgresql://user:pass@localhost:5432/agentspace"),
    /requires_isolated_database/,
  );
});

test("pool loadtest reports an interpolated P95", () => {
  assert.equal(percentile95([]), null);
  assert.equal(percentile95([8, 2, 5, 10, 4]), 10);
  assert.equal(percentile95([4, 1]), 4);
});
