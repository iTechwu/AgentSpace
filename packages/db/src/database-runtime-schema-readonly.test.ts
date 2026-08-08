import assert from "node:assert/strict";
import test from "node:test";
import { ensureRuntimeSchemaForTests } from "./database.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

/**
 * Phase 1 把运行时 ensureRuntimeSchema 收窄为只读校验：schema 已当前/比实例新 → memo；
 * schema 过期 → 抛错指向 `prisma migrate deploy`；不再在请求路径跑 DDL、不再取 advisory 锁。
 * 这些用例用注入（mock）db 直接断言三条分支，并锁定「过期时不执行任何 DDL（exec 为空）」这一不变量，
 * 防止有人重新把自迁移 DDL 塞回运行时路径。全部为 mock，不触真实 PG。
 */

type EnsureDb = Parameters<typeof ensureRuntimeSchemaForTests>[0];

interface MockOptions {
  appMetadataExists: boolean;
  schemaVersion?: string;
  sentinelPresent?: boolean;
  workspaceExists?: boolean;
}

function makeMockDb(opts: MockOptions): { db: EnsureDb; execCalls: string[] } {
  const execCalls: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        all: () => [],
        get: () => {
          if (sql.includes("information_schema.tables") && sql.includes("app_metadata")) {
            return opts.appMetadataExists ? { present: 1 } : undefined;
          }
          if (sql.includes("FROM app_metadata")) {
            return opts.schemaVersion === undefined ? undefined : { value: opts.schemaVersion };
          }
          if (sql.includes("information_schema.columns")) {
            return opts.sentinelPresent ? { present: 1 } : undefined;
          }
          if (sql.includes("FROM workspace")) {
            return opts.workspaceExists ? { id: "default" } : undefined;
          }
          return undefined;
        },
        run: () => ({ changes: 0 }),
      };
    },
    exec(sql: string) {
      execCalls.push(sql);
    },
  } as unknown as EnsureDb;
  return { db, execCalls };
}

test("ensureRuntimeSchema 在 schema 过期时抛错，且不执行任何 DDL（运行时只读）", () => {
  const { db, execCalls } = makeMockDb({
    appMetadataExists: true,
    schemaVersion: "114",
    sentinelPresent: true,
  });

  assert.throws(
    () => ensureRuntimeSchemaForTests(db),
    (error: Error) =>
      /is not at version 116/.test(error.message) && /prisma migrate deploy/.test(error.message),
    "过期库应抛出指向 prisma migrate deploy 的明确错误",
  );
  assert.equal(execCalls.length, 0, "过期库不得执行任何 DDL（Phase 1 运行时路径只读，不自迁移）");
});

test("ensureRuntimeSchema 对当前库 seed + memo，不抛错且无 DDL", () => {
  const { db, execCalls } = makeMockDb({
    appMetadataExists: true,
    schemaVersion: POSTGRES_SCHEMA_VERSION,
    sentinelPresent: true,
    workspaceExists: true,
  });

  assert.doesNotThrow(() => ensureRuntimeSchemaForTests(db));
  assert.equal(
    execCalls.length,
    0,
    "当前库校验也不得执行 DDL（seedDefaultWorkspace 是幂等数据 upsert，走 prepare 而非 exec）",
  );
});

test("ensureRuntimeSchema 前向守卫：库比实例新时跳过、不抛错、不降级", () => {
  const { db, execCalls } = makeMockDb({
    appMetadataExists: true,
    schemaVersion: "117",
    sentinelPresent: true,
  });

  assert.doesNotThrow(() => ensureRuntimeSchemaForTests(db));
  assert.equal(execCalls.length, 0, "前向跳过路径不执行 DDL");
});

test("ensureRuntimeSchema 缺 app_metadata 表（未迁移）视为 stale 并抛错", () => {
  const { db, execCalls } = makeMockDb({ appMetadataExists: false });

  assert.throws(
    () => ensureRuntimeSchemaForTests(db),
    /is not at version 116/,
    "缺 app_metadata 的库应判为 stale 并抛错，而非尝试自迁移建表",
  );
  assert.equal(execCalls.length, 0, "未迁移库不得在运行时自行建表");
});
