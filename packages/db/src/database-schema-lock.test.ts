import assert from "node:assert/strict";
import test from "node:test";
import { acquireRuntimeSchemaLockForTests, isRuntimeSchemaCurrentForTests } from "./database.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

test("acquireRuntimeSchemaLock retries until the schema lock is available", () => {
  const acquiredValues = [false, false, true];
  const attemptedSql: string[] = [];
  let now = 0;

  const result = acquireRuntimeSchemaLockForTests({
    prepare(sql: string) {
      attemptedSql.push(sql);
      return {
        all: () => [],
        get: () => ({ acquired: acquiredValues.shift() ?? false }),
        run: () => ({ changes: 0 }),
      };
    },
  }, {
    now: () => now,
    retryMs: 25,
    sleep: (durationMs) => {
      now += durationMs;
    },
    timeoutMs: 100,
  });

  assert.equal(result.attempts, 3);
  assert.deepEqual(attemptedSql, [
    "SELECT pg_try_advisory_lock(?) AS acquired",
    "SELECT pg_try_advisory_lock(?) AS acquired",
    "SELECT pg_try_advisory_lock(?) AS acquired",
  ]);
  assert.equal(now, 50);
});

test("acquireRuntimeSchemaLock fails with an actionable message when the lock stays busy", () => {
  let now = 0;

  assert.throws(() =>
    acquireRuntimeSchemaLockForTests({
      prepare() {
        return {
          all: () => [],
          get: () => ({ acquired: false }),
          run: () => ({ changes: 0 }),
        };
      },
    }, {
      now: () => now,
      retryMs: 20,
      sleep: (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 60,
    }),
  /PostgreSQL schema migration lock is busy after 60ms/);

  assert.equal(now, 60);
});

test("runtime schema checks stay inside the active PostgreSQL schema", () => {
  const attemptedSql: string[] = [];
  const current = isRuntimeSchemaCurrentForTests({
    prepare(sql: string) {
      attemptedSql.push(sql);
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          if (sql.includes("information_schema.tables")) return { "1": 1 };
          if (sql.includes("FROM app_metadata")) {
            assert.deepEqual(parameters, ["schema_version"]);
            return { value: POSTGRES_SCHEMA_VERSION };
          }
          return { "1": 1 };
        },
        run: () => ({ changes: 0 }),
      };
    },
  });

  assert.equal(current, true);
  assert.equal(attemptedSql.length, 3);
  assert.ok(attemptedSql.every((sql) => !sql.includes("'public'")));
  assert.equal(attemptedSql.filter((sql) => sql.includes("current_schema()")).length, 2);
});
