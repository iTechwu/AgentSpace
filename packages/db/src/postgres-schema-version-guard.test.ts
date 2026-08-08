import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import { ensurePostgresSchema } from "./postgres.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

/**
 * 单元 3 测试：DB 级单调版本守卫（#1）。
 * 针对真实 PG（agent_space_test），验证：
 *   - BEFORE INSERT OR UPDATE 触发器拒绝把 schema_version 降级（check_violation）；
 *   - 同版本/无旧行/非数字值等情形放行，不误伤热路径；
 *   - 4 处版本写带单调 WHERE 时降级为静默 no-op（行不变、触发器不触发）；
 *   - 维护路径 ensurePostgresSchema 对「比实例更新的库」前向跳过（不重跑语句、不降级）。
 *
 * 每个会破坏 schema_version / 触发器的用例都在事务内 ROLLBACK 或在 finally 复原，
 * 不污染共享测试库。
 */

function readVersion(): string {
  const row = getDatabase().prepare(
    "SELECT value FROM app_metadata WHERE key = 'schema_version' LIMIT 1",
  ).get() as { value?: string } | undefined;
  return row?.value ?? "";
}

function triggerExists(): boolean {
  // pg_trigger.tgname 比 information_schema 更可靠（不受 schema 搜索路径影响）。
  const row = getDatabase().prepare(
    `SELECT 1 FROM pg_trigger
     WHERE tgname = 'app_metadata_schema_version_monotonic'
       AND NOT tgisinternal
     LIMIT 1`,
  ).get();
  return Boolean(row);
}

before(() => {
  // 触发 ensureRuntimeSchema：确保测试库已应用单调触发器（幂等）。
  getDatabase();
});

after(() => {
  resetDatabaseForTests();
});

test("POSTGRES_SCHEMA_VERSION 为 116，使「117」对实例而言确属更新", () => {
  assert.equal(POSTGRES_SCHEMA_VERSION, "116");
});

test("DB 触发器拒绝把 schema_version 降级（check_violation）", () => {
  const db = getDatabase();
  const current = readVersion();
  const lower = `${Number.parseInt(current, 10) - 1}`;
  assert.throws(
    () => db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'schema_version'").run(lower),
    /cannot be downgraded|check_violation|23514/i,
  );
  assert.equal(readVersion(), current, "降级被拒后版本不得改变");
});

test("同版本 UPDATE 通过（触发器对 new_int < old_int 才生效）", () => {
  const db = getDatabase();
  const current = readVersion();
  // 116 -> 116：116 < 116 为假，放行；热路径同版本写入不会被误拦。
  db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'schema_version'").run(current);
  assert.equal(readVersion(), current);
});

test("带单调守卫 WHERE 的降级 INSERT 静默 no-op（行不变、不抛、触发器不触发）", () => {
  const db = getDatabase();
  const current = readVersion();
  const lower = `${Number.parseInt(current, 10) - 1}`;
  db.prepare(
    `INSERT INTO app_metadata (key, value)
     VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
     WHERE EXCLUDED.value ~ '^\\d+$'
       AND (app_metadata.value !~ '^\\d+$' OR app_metadata.value::bigint <= EXCLUDED.value::bigint)`,
  ).run(lower);
  assert.equal(readVersion(), current, "守卫 WHERE 必须使降级成为 no-op，行不变");
});

test("无旧行的 INSERT 放行（DELETE 后重建不触发单调检查）", () => {
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM app_metadata WHERE key = 'schema_version'").run();
    // INSERT 时 OLD IS NULL，触发器直接 RETURN NEW，不应用单调约束。
    db.prepare("INSERT INTO app_metadata (key, value) VALUES ('schema_version', '116')").run();
    assert.equal(readVersion(), "116");
  } finally {
    db.exec("ROLLBACK");
  }
});

test("非数字 schema_version 值不崩溃（历史脏值放行）", () => {
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    // OLD=116（数字），NEW='garbage'：new_int 解析抛 invalid_text_representation，被捕获后放行。
    db.prepare("UPDATE app_metadata SET value = 'garbage' WHERE key = 'schema_version'").run();
    assert.equal(readVersion(), "garbage");
  } finally {
    db.exec("ROLLBACK");
  }
});

test("ensurePostgresSchema 跳过比实例更新的库（前向守卫：不降级、不重跑语句）", async () => {
  const db = getDatabase();
  const original = readVersion();
  // 探针：先摘掉单调触发器，再把版本抬到比实例更新（117 > 116）。
  // 若前向守卫生效 → ensurePostgresSchema 直接返回，语句不跑 → 触发器保持删除态；
  // 若未生效 → 语句会重建触发器。借此可观测「是否真正跳过」。
  db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
  db.prepare("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'").run();
  assert.equal(triggerExists(), false, "前置：探针已摘除触发器");
  try {
    const status = await ensurePostgresSchema({});
    assert.equal(status.schemaVersion, "117", "不得降级比实例更新的库");
    assert.equal(triggerExists(), false, "前向守卫应跳过语句，不得重建触发器");
  } finally {
    // 复原：先摘触发器（确保写回更低版本不被拦），再写回原版本，最后重建触发器。
    db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
    db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'schema_version'").run(original);
    db.exec(
      `CREATE TRIGGER app_metadata_schema_version_monotonic
         BEFORE INSERT OR UPDATE OF value ON app_metadata
         FOR EACH ROW EXECUTE FUNCTION guard_schema_version_monotonic()`,
    );
    assert.equal(readVersion(), original, "复原：版本已写回");
    assert.equal(triggerExists(), true, "复原：触发器已重建");
  }
});
