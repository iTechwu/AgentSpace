import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { ensurePostgresSchema, migratePostgresToPostgres } from "./postgres.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres-cli.ts");
const newerSchemaVersion = String(Number(POSTGRES_SCHEMA_VERSION) + 1);

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
    // 抬高目标库版本（> 当前实例）——单调触发器允许升级，使目标库「比实例更新」。
    const targetBumper = new Client({ connectionString: dbs.targetUrl });
    await targetBumper.connect();
    try {
      await targetBumper.query("UPDATE app_metadata SET value = $1 WHERE key = 'schema_version'", [newerSchemaVersion]);
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
    // 目标库版本保持当前实例版本 → 兼容。

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

test("migratePostgresToPostgres 忽略旧库已废弃列并保留业务行", {
  skip: !hasTestDatabase,
}, async () => {
  const dbs = await createTempDbs();
  try {
    await ensurePostgresSchema({ databaseUrl: dbs.sourceUrl });
    await ensurePostgresSchema({ databaseUrl: dbs.targetUrl });
    const source = new Client({ connectionString: dbs.sourceUrl });
    await source.connect();
    try {
      // 模拟历史库遗留字段：当前目标 schema 已不再定义 workspace.join_code。
      await source.query("ALTER TABLE workspace ADD COLUMN join_code TEXT");
      await source.query(
        `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at, join_code)
         VALUES ('ws-pgpg-legacy-column', 'legacy', 'legacy', 'test', now(), now(), 'old-code')`,
      );
      await source.query(
        `INSERT INTO agent_runtime (
          id, workspace_id, provider, name, created_at, updated_at
        ) VALUES (
          'runtime-pgpg-mcp', 'ws-pgpg-legacy-column', 'codex', 'Codex', now(), now()
        )`,
      );
      await source.query(
        `INSERT INTO workspace_sso_binding (
          workspace_id, tenant_id, tenant_name, team_id, team_name, source, synced_at
        ) VALUES (
          'ws-pgpg-legacy-column', 'tenant-pgpg', 'PGPG Tenant', 'team-pgpg', 'PGPG Team', 'team', now()
        )`,
      );
      await source.query(
        `INSERT INTO mcp_catalog_item (
          id, workspace_id, slug, transport, display_name, synced_at, created_at, updated_at
        ) VALUES (
          'catalog-pgpg-mcp', 'ws-pgpg-legacy-column', 'test-mcp', 'streamable_http', 'Test MCP', now(), now(), now()
        )`,
      );
      await source.query(
        `INSERT INTO runtime_mcp_connection (
          id, workspace_id, runtime_id, catalog_item_id, status, endpoint, created_at, updated_at
        ) VALUES (
          'connection-pgpg-mcp', 'ws-pgpg-legacy-column', 'runtime-pgpg-mcp', 'catalog-pgpg-mcp', 'ready', 'https://mcp.example.test', now(), now()
        )`,
      );
      await source.query(
        `INSERT INTO runtime_mcp_secret (
          connection_id, field_name, encrypted_value, key_version, rotated_at
        ) VALUES (
          'connection-pgpg-mcp', 'TOKEN', 'mcp1:fixture', 'mcp1', now()
        )`,
      );
    } finally {
      await source.end();
    }

    const report = await migratePostgresToPostgres({
      sourceDatabaseUrl: dbs.sourceUrl,
      targetDatabaseUrl: dbs.targetUrl,
      reset: true,
    });

    assert.equal(report.status, "completed");
    assert.ok(
      report.warnings.some((warning) => /workspace.*join_code/.test(warning)),
      "报告必须说明已忽略遗留字段",
    );
    const target = new Client({ connectionString: dbs.targetUrl });
    await target.connect();
    try {
      const row = await target.query<{ id: string }>(
        "SELECT id FROM workspace WHERE id = 'ws-pgpg-legacy-column'",
      );
      assert.equal(row.rows[0]?.id, "ws-pgpg-legacy-column", "兼容投影后应保留业务行");
      const importedDependencies = await target.query<{ connection_count: string; secret_count: string; sso_binding_count: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM runtime_mcp_connection WHERE id = 'connection-pgpg-mcp') AS connection_count,
           (SELECT COUNT(*)::text FROM runtime_mcp_secret WHERE connection_id = 'connection-pgpg-mcp') AS secret_count,
           (SELECT COUNT(*)::text FROM workspace_sso_binding WHERE workspace_id = 'ws-pgpg-legacy-column' AND team_id = 'team-pgpg') AS sso_binding_count`,
      );
      assert.deepEqual(
        importedDependencies.rows[0],
        { connection_count: "1", secret_count: "1", sso_binding_count: "1" },
        "托管运行时的 SSO 范围以及 MCP 目录、连接与加密密钥必须完整迁移",
      );
    } finally {
      await target.end();
    }
  } finally {
    await dropTempDbs(dbs);
  }
});

/**
 * Standards #4（迁移跳过退出码）：postgres-cli 的 migrate 命令在报告 skipped_incompatible_schema 时
 * 原先仍以退出码 0 静默成功——CI/脚本无法据退出码判断迁移未执行。修复后跳过须以非零退出码 2 告知
 *（区别于错误退出码 1），completed 保持 0。通过 spawnSync 真实拉起 CLI 进程验证退出码契约。
 */
test("postgres-cli migrate-from-postgres dry-run 面对新版目标库以退出码 2 告知跳过（不静默成功）", {
  skip: !hasTestDatabase,
}, async () => {
  const dbs = await createTempDbs();
  try {
    await ensurePostgresSchema({ databaseUrl: dbs.sourceUrl });
    await ensurePostgresSchema({ databaseUrl: dbs.targetUrl });
    const targetBumper = new Client({ connectionString: dbs.targetUrl });
    await targetBumper.connect();
    try {
      await targetBumper.query("UPDATE app_metadata SET value = $1 WHERE key = 'schema_version'", [newerSchemaVersion]);
    } finally {
      await targetBumper.end();
    }

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", CLI_PATH, "migrate-from-postgres",
        "--source-database-url", dbs.sourceUrl,
        "--target-database-url", dbs.targetUrl,
        "--dry-run", "--json",
      ],
      { encoding: "utf-8" },
    );

    assert.equal(result.status, 2, `新版目标库须以退出码 2 告知跳过（stdout: ${result.stdout}; stderr: ${result.stderr}）`);
    const report = JSON.parse(result.stdout) as { status: string };
    assert.equal(report.status, "skipped_incompatible_schema", "CLI 输出的报告 status 须为 skipped_incompatible_schema");
  } finally {
    await dropTempDbs(dbs);
  }
});

test("postgres-cli migrate-from-postgres dry-run 面对兼容目标库以退出码 0 成功", {
  skip: !hasTestDatabase,
}, async () => {
  const dbs = await createTempDbs();
  try {
    await ensurePostgresSchema({ databaseUrl: dbs.sourceUrl });
    await ensurePostgresSchema({ databaseUrl: dbs.targetUrl });
    // 目标库版本保持 116（= 实例版本）→ 兼容，dry-run 报告 completed。

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", CLI_PATH, "migrate-from-postgres",
        "--source-database-url", dbs.sourceUrl,
        "--target-database-url", dbs.targetUrl,
        "--dry-run", "--json",
      ],
      { encoding: "utf-8" },
    );

    assert.equal(result.status, 0, `兼容目标库须以退出码 0 成功（stdout: ${result.stdout}; stderr: ${result.stderr}）`);
  } finally {
    await dropTempDbs(dbs);
  }
});
