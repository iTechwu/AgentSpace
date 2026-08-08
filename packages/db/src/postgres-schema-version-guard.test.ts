import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import {
  ensurePostgresConcurrentIndexes,
  ensurePostgresSchema,
  migrateSqliteToPostgres,
  truncatePostgresTablesForTests,
} from "./postgres.ts";
import {
  POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID,
  POSTGRES_SCHEMA_ADVISORY_LOCK_IDS,
  POSTGRES_SCHEMA_VERSION,
} from "./postgres-schema.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";

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

/**
 * Standards #2（TOCTOU）：ensurePostgresSchema 取锁后才复检版本，消除「锁外检查 → 取锁」窗口。
 * 阻塞者占住 [115,116] → ensurePostgresSchema 进入等锁 → 期间另一连接把版本抬到 117 →
 * 释放锁 → ensurePostgresSchema 取锁后复检发现 117 > 116 → 跳过语句（不重建探针触发器、不降级）。
 * 旧实现（锁外检查）会把检查时的 116 判定为「不更新」并继续执行语句，触发器被重建、版本被降级。
 */
test("ensurePostgresSchema 锁内复检版本，消除 TOCTOU（取锁后才检查）", async () => {
  const db = getDatabase();
  const original = readVersion();
  // 探针：摘掉单调触发器，方便自由改写版本观测「是否重跑语句」。
  db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
  // 起始版本=116（实例版本）→ 旧实现的锁外检查会判定「不更新」并放行进入取锁；新实现取锁后复检。
  db.prepare("UPDATE app_metadata SET value = '116' WHERE key = 'schema_version'").run();
  assert.equal(triggerExists(), false, "前置：探针触发器已摘除");

  const url = resolvePostgresDatabaseUrl();
  const blocker = new Client({ connectionString: url });
  await blocker.connect();
  try {
    // blocker 占住迁移锁 [115,116] → ensurePostgresSchema 取锁时阻塞。
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await blocker.query("SELECT pg_advisory_lock($1)", [lockId]);
    }

    const bumper = new Client({ connectionString: url });
    await bumper.connect();
    try {
      const ensurePromise = ensurePostgresSchema({});
      // 让 ensurePostgresSchema 先进入等锁（此时锁外旧检查已读过 116）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 在等锁窗口把版本抬到 117（> 实例 116）。
      await bumper.query("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'");
      // 释放锁，让 ensurePostgresSchema 取锁后做锁内复检。
      for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
        await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);
      }
      const status = await ensurePromise;
      assert.equal(status.schemaVersion, "117", "锁内复检发现版本更新 → 不得降级");
      assert.equal(triggerExists(), false, "锁内复检跳过语句，不得重建探针触发器");
    } finally {
      await bumper.end();
    }
  } finally {
    await blocker.end();
    // 复原：摘触发器后写回原版本，再重建触发器。
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

/**
 * Issue 2（后台维护前向守卫）：ensurePostgresConcurrentIndexes 是 getDatabase() 启动的后台自愈入口
 *（database.ts:715 → ensurePostgresConcurrentIndexes → runBackgroundMaintenance）。它原先没有
 * ensureRuntimeSchema/ensurePostgresSchema 那样的前向版本守卫——滚动升级时旧实例（116）会在新实例
 *（117+）已推进的库上执行 history 回填 / SET NOT NULL / 索引 DDL，可能与新 schema 冲突。修复：入口处
 * 复用 isPostgresSchemaNewerThanInstance，库版本 > 实例版本即直接返回，不取锁 117、不发任何 DDL。
 */
test("ensurePostgresConcurrentIndexes 跳过比实例更新的库（前向守卫：不发后台维护 DDL）", async () => {
  const db = getDatabase();
  const original = readVersion();
  // 探针：摘掉单调触发器（便于后续写回更低版本）→ 抬版本到 117（> 实例 116）→ 删除回填 flag。
  // 若前向守卫生效 → ensurePostgresConcurrentIndexes 直接返回，不跑维护 → flag 保持删除态；
  // 若未生效 → runBackgroundMaintenance 末尾会把 flag 置 'true'。借此观测「是否真正跳过」。
  db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
  db.prepare("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'").run();
  db.prepare("DELETE FROM app_metadata WHERE key = 'schema_116_history_backfill_complete'").run();
  try {
    await ensurePostgresConcurrentIndexes({});
    const flag = db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_116_history_backfill_complete' LIMIT 1")
      .get() as { value?: string } | undefined;
    assert.equal(flag?.value, undefined, "前向守卫应跳过后台维护，不得回写 backfill flag");
  } finally {
    // 复原：摘触发器后写回原版本，重建触发器，回填 flag 设回 true（测试库已完成回填）。
    db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
    db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'schema_version'").run(original);
    db.exec(
      `CREATE TRIGGER app_metadata_schema_version_monotonic
         BEFORE INSERT OR UPDATE OF value ON app_metadata
         FOR EACH ROW EXECUTE FUNCTION guard_schema_version_monotonic()`,
    );
    db.prepare(
      `INSERT INTO app_metadata (key, value) VALUES ('schema_116_history_backfill_complete', 'true')
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ).run();
    assert.equal(readVersion(), original, "复原：版本已写回");
    assert.equal(triggerExists(), true, "复原：触发器已重建");
  }
});

/**
 * Standards #2（后台维护 TOCTOU）：ensurePostgresConcurrentIndexes 取后台锁 117 后才复检版本，
 * 消除「锁外检查 → 取锁 117」窗口。阻塞者占住 117 → 后台维护进入等锁 → 期间另一连接把版本抬到
 * 117 → 释放锁 → 后台维护取锁后复检发现 117 > 116 → 跳过维护（不回写 backfill flag）。旧实现
 * （锁外检查）会把检查时的 116 判定为「不更新」并继续 runBackgroundMaintenance，回写 flag。
 */
test("ensurePostgresConcurrentIndexes 锁内复检版本，消除 TOCTOU（取锁后才检查）", async () => {
  const db = getDatabase();
  const original = readVersion();
  // 探针：摘触发器 + 起始版本=116（实例版本）+ 删除回填 flag。
  // 旧实现的锁外检查会读 116 判定「不更新」放行进入取锁；新实现取后台锁 117 后复检。
  db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
  db.prepare("UPDATE app_metadata SET value = '116' WHERE key = 'schema_version'").run();
  db.prepare("DELETE FROM app_metadata WHERE key = 'schema_116_history_backfill_complete'").run();

  const url = resolvePostgresDatabaseUrl();
  const blocker = new Client({ connectionString: url });
  await blocker.connect();
  try {
    // blocker 占住后台维护锁 117 → ensurePostgresConcurrentIndexes 取锁时阻塞。
    await blocker.query("SELECT pg_advisory_lock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);

    const bumper = new Client({ connectionString: url });
    await bumper.connect();
    try {
      const ensurePromise = ensurePostgresConcurrentIndexes({});
      // 让后台维护先进入等锁（此时锁外旧检查已读过 116）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 在等锁窗口把版本抬到 117（> 实例 116）。
      await bumper.query("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'");
      // 释放 117，让后台维护取锁后做锁内复检。
      await blocker.query("SELECT pg_advisory_unlock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);
      await ensurePromise;
      const flag = db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_116_history_backfill_complete' LIMIT 1")
        .get() as { value?: string } | undefined;
      assert.equal(flag?.value, undefined, "锁内复检发现版本更新 → 须跳过后台维护，不得回写 backfill flag");
    } finally {
      await bumper.end();
    }
  } finally {
    await blocker.end();
    // 复原：摘触发器后写回原版本，重建触发器，回填 flag 设回 true（测试库已完成回填）。
    db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
    db.prepare("UPDATE app_metadata SET value = ? WHERE key = 'schema_version'").run(original);
    db.exec(
      `CREATE TRIGGER app_metadata_schema_version_monotonic
         BEFORE INSERT OR UPDATE OF value ON app_metadata
         FOR EACH ROW EXECUTE FUNCTION guard_schema_version_monotonic()`,
    );
    db.prepare(
      `INSERT INTO app_metadata (key, value) VALUES ('schema_116_history_backfill_complete', 'true')
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ).run();
    assert.equal(readVersion(), original, "复原：版本已写回");
    assert.equal(triggerExists(), true, "复原：触发器已重建");
  }
});

/**
 * P1 冷启动不阻塞（postgres.ts:847 回归守卫）：ensurePostgresConcurrentIndexes 只取后台锁 117，
 * 不得竞争 schema 迁移锁 [115,116]。若实现错误地把维护包入 withPostgresSchemaLock，则当另一实例
 * 正在进行 schema 主事务迁移（持有 [115,116]）时，后台维护会以阻塞型 pg_advisory_lock 等 [115,116]；
 * 反方向亦然——维护持 [115,116] 贯穿大表回填/建索引会超过 acquireRuntimeSchemaLock 的 ~9s 超时，
 * 令第二实例冷启动抛 "schema lock busy" 失败。本用例长期占用 [115,116] 模拟并发冷启动迁移，
 * 断言后台维护仍能在限期内完成（因为它只取 117）。
 */
test("ensurePostgresConcurrentIndexes 不竞争 schema 迁移锁 [115,116]（冷启动迁移进行中仍可完成后台维护）", async () => {
  // 确保维护走快路径（回填已完成）：专注验证锁竞争，不引入回填耗时的不确定性。
  getDatabase().prepare(
    `INSERT INTO app_metadata (key, value) VALUES ('schema_116_history_backfill_complete', 'true')
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
  ).run();

  const url = resolvePostgresDatabaseUrl();
  const blocker = new Client({ connectionString: url });
  await blocker.connect();
  try {
    // blocker 长期占用 [115,116]，模拟另一实例正在执行 schema 主事务迁移。
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await blocker.query("SELECT pg_advisory_lock($1)", [lockId]);
    }
    // 后台维护只应取 117；干净库（flag 已置）维护为幂等索引检查，正常秒级完成，8s 上限远超正常耗时。
    await Promise.race([
      ensurePostgresConcurrentIndexes({}),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("后台维护被 schema 迁移锁 [115,116] 阻塞超过 8s——疑似重新竞争冷启动迁移锁")),
          8000,
        ),
      ),
    ]);
  } finally {
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);
    }
    await blocker.end();
  }
});

/**
 * Issue 3（迁移命令静默成功）：目标库版本更高时，旧实现的前向守卫静默 return，外层仍返回成功报告，
 * SQLite dry-run 甚至把所有记录标为 insertedCount=sourceCount（line 431）——调用方误以为已迁入数据。
 * 修复：报告新增 status 字段，跳过时置 skipped_incompatible_schema、所有表 insertedCount=0、
 * 追加 warning，并在 dryRun「全部可插入」改写前短路返回。
 */
test("migrateSqliteToPostgres 目标库版本更高时报告 skipped_incompatible_schema（不误报已迁入）", async () => {
  const db = getDatabase();
  const original = readVersion();
  const sqlitePath = `${tmpdir()}/dofe-migrate-skip-${Math.random().toString(36).slice(2)}.sqlite`;
  // 预建一个空 sqlite 源库（无任何业务表）——migrate 入口会校验文件存在。
  new DatabaseSync(sqlitePath).close();
  try {
    // 探针：摘触发器 + 抬版本到 117（> 实例 116），令锁内前向守卫触发。
    db.exec("DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata");
    db.prepare("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'").run();

    const report = await migrateSqliteToPostgres({
      databaseUrl: resolvePostgresDatabaseUrl(),
      sqlitePath,
      dryRun: true,
    });

    assert.equal(report.status, "skipped_incompatible_schema", "目标库更新时须显式跳过，不得静默成功");
    // 关键：dryRun 原本会把 insertedCount 篡改为 sourceCount（误报「全部可插入」）；跳过分支须挡住它。
    for (const table of report.tables) {
      assert.equal(table.insertedCount, 0, `${table.tableName}: 跳过时不得报告已插入`);
    }
    assert.ok(
      report.warnings.some((w) => /skipped_incompatible_schema/.test(w)),
      "须在 warnings 中说明跳过原因",
    );
  } finally {
    rmSync(sqlitePath, { force: true });
    // 复原：摘触发器后写回原版本，重建触发器。
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

/**
 * Standards #2（reset 不清 app_metadata）：reset 截断排除 app_metadata，schema_version 与其它元数据
 * 标记存活 → 后续版本写命中既有行并受单调守卫约束，无法降级；其它标记（如回填 flag）也保留。
 */
test("truncatePostgresTables 排除 app_metadata，保留 schema_version 与回填 flag", async () => {
  const db = getDatabase();
  const original = readVersion();
  const url = resolvePostgresDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // 种子一个非 version 的 app_metadata 标记（模拟回填 flag），验证整表保留。
    db.prepare(
      `INSERT INTO app_metadata (key, value) VALUES ('schema_116_history_backfill_complete', 'true')
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ).run();

    await truncatePostgresTablesForTests(client);

    assert.equal(readVersion(), original, "reset 不得清除 schema_version（app_metadata 保留）");
    const flag = db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_116_history_backfill_complete' LIMIT 1")
      .get() as { value?: string } | undefined;
    assert.equal(flag?.value, "true", "其它 app_metadata 标记也随表保留");
  } finally {
    await client.end();
    db.prepare("DELETE FROM app_metadata WHERE key = 'schema_116_history_backfill_complete'").run();
  }
});
