import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireRuntimeSchemaLockForTests,
  getDatabase,
  isDatabaseSchemaNewerThanInstanceForTests,
  isRuntimeSchemaCurrentForTests,
  resetConcurrentIndexBuildForTests,
  resetDatabaseForTests,
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

// Phase 1 起 ensureRuntimeSchema 收窄为只读校验：运行时不再取 117/[115,116] 锁、不再跑 DDL——schema 过期
// 直接抛错（见 database-runtime-schema-readonly.test.ts）。acquireRuntimeSchemaLock 仍作为工具保留
// （ensurePostgresSchema CLI 迁移路径继续使用），上方 try+超时单测守护其语义；随运行时慢路径移除的 117 单次
// try 逻辑不再需要独立单测。

test("runtime schema checks stay inside the active PostgreSQL schema", () => {
  const attemptedSql: string[] = [];
  const current = isRuntimeSchemaCurrentForTests({
    prepare(sql: string) {
      attemptedSql.push(sql);
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          if (sql.includes("information_schema.tables")) return { present: 1 };
          if (sql.includes("FROM app_metadata")) {
            assert.deepEqual(parameters, ["schema_version"]);
            return { value: POSTGRES_SCHEMA_VERSION };
          }
          return { present: 1 };
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
          if (sql.includes("information_schema.tables")) return { present: 1 };
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
            if (sql.includes("information_schema.tables")) return { present: 1 };
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

// 真实 PostgreSQL 契约守卫：上方 isRuntimeSchemaCurrent / isDatabaseSchemaNewerThanInstance 的 mock 用例
// 若仅以 {"1": 1} 模拟存在性检查，会掩盖「裸 SELECT 1 在真实 PG 上列名为 "?column?" 而非 "1"」这一事实——
// 旧实现按 row["1"] 读取恒为 undefined，使无锁快速路径与前向版本守卫在真实库上全部失效。本用例锁定真实 PG
// 的列名行为并断言修复后函数对当前库返回正确值，禁止回归到只能被 {"1": 1} mock 喂过的假阳性实现。
test("真实 PG 上 schema 检查读显式别名——禁止 {\"1\": 1} mock 形成的假阳性", () => {
  resetDatabaseForTests();
  resetConcurrentIndexBuildForTests();
  // 注入 no-op builder，避免 getDatabase 触发的后台在线索引构建在此做真实 PG 工作。
  triggerConcurrentIndexBuildForTests("__noop__", async () => {});
  try {
    const db = getDatabase();

    // 契约一：裸 SELECT 1 在真实 PG 上列名为 "?column?"，绝无 "1" 键。
    const bare = db.prepare("SELECT 1").get() as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(bare, "1"),
      false,
      '裸 SELECT 1 不得返回 "1" 键；真实 PG 列名为 "?column?"，禁止仅以 {"1": 1} mock 掩盖',
    );

    // 契约二：显式别名 AS present 稳定可读。
    const aliased = db.prepare("SELECT 1 AS present").get() as { present?: number };
    assert.equal(aliased.present, 1, "SELECT 1 AS present 须经 .present 稳定读取");

    // 契约三：修复后真实当前库（schema_version = POSTGRES_SCHEMA_VERSION）须判定为「已就绪」
    // 且「不比实例更新」。修复前这两项在真实 PG 上恒为 false（快速路径与前向守卫双失效）。
    assert.equal(
      isRuntimeSchemaCurrentForTests(db),
      true,
      "修复后真实当前库须判定为 schema 已就绪（无锁快速路径生效）",
    );
    assert.equal(
      isDatabaseSchemaNewerThanInstanceForTests(db),
      false,
      "当前版本库不比实例更新（前向守卫正确放行升级迁移）",
    );
  } finally {
    resetDatabaseForTests();
    resetConcurrentIndexBuildForTests();
  }
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
