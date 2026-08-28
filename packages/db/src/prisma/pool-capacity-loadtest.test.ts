import assert from "node:assert/strict";
import test from "node:test";
import {
  percentile95,
  runPrismaPoolCapacityLoadTest,
  validatePrismaPoolLoadTestDatabaseUrl,
} from "./pool-capacity-loadtest.ts";

const testDatabaseUrl = process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL;
const hasIsolatedTestDatabase = (() => {
  if (!testDatabaseUrl) return false;
  try {
    validatePrismaPoolLoadTestDatabaseUrl(testDatabaseUrl);
    return true;
  } catch {
    return false;
  }
})();

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

test("pool loadtest executes the typed hold query and disconnects during in-flight work", {
  skip: !hasIsolatedTestDatabase,
}, async () => {
  const report = await runPrismaPoolCapacityLoadTest({
    databaseUrl: testDatabaseUrl!,
    role: "daemon",
    concurrency: 2,
    holdMs: 100,
    connectionTimeoutMs: 1_000,
    statementTimeoutMs: 2_000,
  });

  assert.equal(report.completed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.connectionTimedOut, 0);
  assert.equal(report.statementTimedOut, 0);
  assert.ok(report.observedConnections > 0);
  assert.ok(report.activeConnections > 0);
  assert.ok(report.p95Ms !== null && report.p95Ms >= report.holdMs);
  assert.equal(report.gracefulShutdownDuringInflight, true);
});
