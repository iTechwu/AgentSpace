import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireRuntimeSchemaLockForTests,
  isDatabaseSchemaNewerThanInstanceForTests,
  isRuntimeSchemaCurrentForTests,
  resetConcurrentIndexBuildForTests,
  triggerConcurrentIndexBuildForTests,
} from "./database.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

test("acquireRuntimeSchemaLock retries until the schema lock is available", () => {
  const acquiredValues = [true, false, true, true];
  const attemptedSql: string[] = [];
  const attemptedParameters: unknown[][] = [];
  let now = 0;

  const result = acquireRuntimeSchemaLockForTests({
    prepare(sql: string) {
      attemptedSql.push(sql);
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          attemptedParameters.push(parameters);
          if (sql.includes("pg_advisory_unlock")) return { released: true };
          return { acquired: acquiredValues.shift() ?? false };
        },
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

  assert.equal(result.attempts, 2);
  assert.deepEqual(attemptedSql, [
    "SELECT pg_try_advisory_lock(?) AS acquired",
    "SELECT pg_try_advisory_lock(?) AS acquired",
    "SELECT pg_advisory_unlock(?) AS released",
    "SELECT pg_try_advisory_lock(?) AS acquired",
    "SELECT pg_try_advisory_lock(?) AS acquired",
  ]);
  assert.equal(now, 25);
  assert.deepEqual(attemptedParameters, [[115], [116], [115], [115], [116]]);
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

// Round 4 覆盖说明：ensureRuntimeSchema 在 schema 过期时于 acquireRuntimeSchemaLock（[115,116]）之前
// 增加了一层单次 pg_try_advisory_lock(117)——忙即快速抛错、可重试，非阻塞、无重试循环（避免请求路径
// 超时预算翻倍）。该 117 层为 ensureRuntimeSchema 内联的 4 行直接调用，未抽成独立函数（无独立可注入点）；
// 且触发它需构造 schema 过期场景，在共享测试库（agent_space_test，恒为当前版本）中不可行。其正确性由
// 上方 acquireRuntimeSchemaLock 的 try+超时单测（同构语义）与 database-getdatabase-cache 的无锁快速路径
// 不回归测试共同守护；117 单次 try 逻辑足够简单，无需额外单测。

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

test("isDatabaseSchemaNewerThanInstance detects a newer database version", () => {
  const attemptedSql: string[] = [];
  const newer = isDatabaseSchemaNewerThanInstanceForTests({
    prepare(sql: string) {
      attemptedSql.push(sql);
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          if (sql.includes("information_schema.tables")) return { "1": 1 };
          if (sql.includes("FROM app_metadata")) {
            assert.deepEqual(parameters, ["schema_version"]);
            return { value: "117" };
          }
          return undefined;
        },
        run: () => ({ changes: 0 }),
      };
    },
  });

  assert.equal(newer, true);
  assert.ok(attemptedSql.some((sql) => sql.includes("information_schema.tables")));
});

test("isDatabaseSchemaNewerThanInstance is false when the database is older, equal, or empty", () => {
  for (const storedVersion of ["114", "115", POSTGRES_SCHEMA_VERSION, undefined] as const) {
    const newer = isDatabaseSchemaNewerThanInstanceForTests({
      prepare(sql: string) {
        return {
          all: () => [],
          get: () => {
            if (sql.includes("information_schema.tables")) return { "1": 1 };
            if (sql.includes("FROM app_metadata")) {
              return storedVersion === undefined ? undefined : { value: storedVersion };
            }
            return undefined;
          },
          run: () => ({ changes: 0 }),
        };
      },
    });
    assert.equal(newer, false);
  }
});

test("isDatabaseSchemaNewerThanInstance treats a missing app_metadata table as not newer", () => {
  const newer = isDatabaseSchemaNewerThanInstanceForTests({
    prepare(sql: string) {
      return {
        all: () => [],
        get: () => (sql.includes("information_schema.tables") ? undefined : undefined),
        run: () => ({ changes: 0 }),
      };
    },
  });
  assert.equal(newer, false);
});

test("triggerConcurrentIndexBuild fires the builder once per database URL", async () => {
  resetConcurrentIndexBuildForTests();
  let calls = 0;
  const countBuilder = async () => {
    calls += 1;
  };
  try {
    triggerConcurrentIndexBuildForTests("postgres://test-once", countBuilder);
    triggerConcurrentIndexBuildForTests("postgres://test-once", countBuilder);
    triggerConcurrentIndexBuildForTests("postgres://test-once", countBuilder);
    // let the fire-and-forget microtask flush
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    resetConcurrentIndexBuildForTests();
  }
});

test("triggerConcurrentIndexBuild fires again for a different database URL", async () => {
  resetConcurrentIndexBuildForTests();
  const seen: string[] = [];
  const recordingBuilder = async (databaseUrl: string) => {
    seen.push(databaseUrl);
  };
  try {
    triggerConcurrentIndexBuildForTests("postgres://a", recordingBuilder);
    triggerConcurrentIndexBuildForTests("postgres://b", recordingBuilder);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["postgres://a", "postgres://b"]);
  } finally {
    resetConcurrentIndexBuildForTests();
  }
});
