import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { ensurePostgresSchema, migratePostgresToPostgres } from "./postgres.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";

/**
 * Spec #7（PG→PG dry-run 误报）：migratePostgresToPostgres 的 dry-run 分支原先在复核目标库版本前
 * 即返回 status=completed 并把 insertedCount 预置为 sourceCount——目标库 schema_version 高于本实例时，
 * 正式迁移会整库跳过，dry-run 却误报「全部可插入」。修复后 dry-run 须锁内复检目标版本：更高→
 * skipped_incompatible_schema（0 inserted + warning）；兼容→completed（insertedCount=sourceCount）。
 *
 * 需要两套真实 PG 库（source/target）。用例在 127.0.0.1 同实例上 CREATE 两个临时库（名含 test 以通过
 * 测试库安全断言），finally DROP。
 */

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
    || process.env.DOFE_AGENT_TEST_DATABASE_URL
    || process.env.DOFE_AGENT_PG_TEST_URL,
);

function deriveDbUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = "/" + dbName;
  return parsed.toString();
}

interface TempDbs {
  sourceUrl: string;
  targetUrl: string;
  sourceDb: string;
  targetDb: string;
}

async function createTempDbs(): Promise<TempDbs> {
  const baseUrl = resolvePostgresDatabaseUrl();
  const suffix = Math.random().toString(36).slice(2, 10);
  const sourceDb = `pgpg_test_src_${suffix}`;
  const targetDb = `pgpg_test_tgt_${suffix}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    await admin.query(`CREATE DATABASE ${targetDb}`);
  } finally {
    await admin.end();
  }
  return {
    sourceUrl: deriveDbUrl(baseUrl, sourceDb),
    targetUrl: deriveDbUrl(baseUrl, targetDb),
    sourceDb,
    targetDb,
  };
}

async function dropTempDbs(dbs: TempDbs): Promise<void> {
  const baseUrl = resolvePostgresDatabaseUrl();
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    // 先终止残留连接，避免 DROP DATABASE 因活动连接失败。
    for (const dbName of [dbs.sourceDb, dbs.targetDb]) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbs.sourceDb}`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbs.targetDb}`);
  } finally {
    await admin.end();
  }
}

test("migratePostgresToPostgres dry-run 面对新版目标库报告 skipped_incompatible_schema（不误报 completed）", {
  skip: !hasTestDatabase,
}, async () => {
  const dbs = await createTempDbs();
  try {
    // source/target 应用 schema；source 种一行 workspace 使 sourceCount > 0（凸显「误报已插入」）。
    await ensurePostgresSchema({ databaseUrl: dbs.sourceUrl });
    await ensurePostgresSchema({ databaseUrl: dbs.targetUrl });
    const sourceSeeder = new Client({ connectionString: dbs.sourceUrl });
    await sourceSeeder.connect();
    try {
      await sourceSeeder.query(
        `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
         VALUES ('ws-pgpg-src', 'src', 'src', 'test', now(), now())`,
      );
    } finally {
      await sourceSeeder.end();
    }
    // 抬高目标库版本到 117（> 实例 116）——单调触发器允许升级，使目标库「比实例更新」。
    const targetBumper = new Client({ connectionString: dbs.targetUrl });
    await targetBumper.connect();
    try {
      await targetBumper.query("UPDATE app_metadata SET value = '117' WHERE key = 'schema_version'");
    } finally {
      await targetBumper.end();
    }

    const report = await migratePostgresToPostgres({
      sourceDatabaseUrl: dbs.sourceUrl,
      targetDatabaseUrl: dbs.targetUrl,
      dryRun: true,
    });

    assert.equal(report.status, "skipped_incompatible_schema", "目标库更新时 dry-run 须显式跳过，不得误报 completed");
    for (const table of report.tables) {
      assert.equal(table.insertedCount, 0, `${table.tableName}: 跳过时不得报告已插入`);
    }
    assert.ok(
      report.warnings.some((w) => /skipped_incompatible_schema/.test(w)),
      "须在 warnings 中说明跳过原因",
    );
  } finally {
    await dropTempDbs(dbs);
  }
});

test("migratePostgresToPostgres dry-run 面对兼容目标库报告 completed（insertedCount=sourceCount）", {
  skip: !hasTestDatabase,
}, async () => {
  const dbs = await createTempDbs();
  try {
    await ensurePostgresSchema({ databaseUrl: dbs.sourceUrl });
    await ensurePostgresSchema({ databaseUrl: dbs.targetUrl });
    const sourceSeeder = new Client({ connectionString: dbs.sourceUrl });
    await sourceSeeder.connect();
    try {
      await sourceSeeder.query(
        `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
         VALUES ('ws-pgpg-compat', 'compat', 'compat', 'test', now(), now())`,
      );
    } finally {
      await sourceSeeder.end();
    }
    // 目标库版本保持 116（= 实例版本）→ 兼容。

    const report = await migratePostgresToPostgres({
      sourceDatabaseUrl: dbs.sourceUrl,
      targetDatabaseUrl: dbs.targetUrl,
      dryRun: true,
    });

    assert.equal(report.status, "completed", "兼容目标库 dry-run 正常报告 completed");
    const workspaceTable = report.tables.find((t) => t.tableName === "workspace");
    assert.ok(workspaceTable, "workspace 表应在快照中");
    assert.equal(workspaceTable!.sourceCount, 1, "前置：source workspace 有 1 行");
    assert.equal(workspaceTable!.insertedCount, 1, "兼容时 dry-run 报告 insertedCount = sourceCount");
    assert.equal(workspaceTable!.skippedCount, 0, "兼容时 dry-run 不应有 skipped");
  } finally {
    await dropTempDbs(dbs);
  }
});
