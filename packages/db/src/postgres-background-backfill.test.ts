import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Client } from "pg";
import {
  getDatabase,
  resetDatabaseForTests,
  resetConcurrentIndexBuildForTests,
  triggerConcurrentIndexBuildForTests,
} from "./database.ts";
import {
  ensurePostgresConcurrentIndexes,
  runBackgroundMaintenanceForTests,
  type PostgresQueryClient,
} from "./postgres.ts";
import {
  POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID,
  POSTGRES_HISTORY_SEQUENCE_SET_NOT_NULL_STATEMENT,
  POSTGRES_SCHEMA_ADVISORY_LOCK_IDS,
} from "./postgres-schema.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";
import {
  createWorkflowDefinitionSync,
  publishWorkflowVersionSync,
} from "./workflows/definitions.ts";
import { createWorkflowRunSync } from "./workflows/runs.ts";

/**
 * 单元 4 测试：在线迁移 + 锁解耦（#2 + #3）。
 * 验证：
 *   - 后台自愈（ensurePostgresConcurrentIndexes，锁 117）幂等且正确地回填 history_sequence、
 *     推进 workspace 序号、施加 NOT NULL、置完成 flag；
 *   - SET NOT NULL 受 information_schema.columns.is_nullable 守卫（flag 已完成或列已 NOT NULL 时不发 ALTER）；
 *   - 后台锁 117 与 schema 迁移锁 [115,116] 互不竞争（长建索引不阻塞冷启动迁移）。
 *
 * 真库用例（agent_space_test）：临时 DROP NOT NULL 造 NULL 行 + 删 flag 触发回填，finally 复原。
 * mock 用例：确定性验证控制流（flag 短路、is_nullable 守卫），无需 DB 状态。
 */

const BACKFILL_FLAG = "schema_116_history_backfill_complete";

before(() => {
  // 注入 no-op 后台 builder，避免 getDatabase 触发的 fire-and-forget 后台任务与本测试显式调用
  // ensurePostgresConcurrentIndexes 在锁 117 上竞争。
  triggerConcurrentIndexBuildForTests("__noop__", async () => {});
  getDatabase();
});

after(() => {
  resetConcurrentIndexBuildForTests();
  resetDatabaseForTests();
});

function readFlag(db = getDatabase()): string | undefined {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ? LIMIT 1").get(BACKFILL_FLAG) as
    | { value?: string }
    | undefined;
  return row?.value;
}

function historySequenceNullable(): "YES" | "NO" | undefined {
  const row = getDatabase().prepare(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'workflow_run'
       AND column_name = 'history_sequence'`,
  ).get() as { is_nullable?: "YES" | "NO" } | undefined;
  return row?.is_nullable;
}

test("后台自愈幂等回填 NULL history_sequence、推进 workspace 序号、施加 NOT NULL、置 flag", async () => {
  const db = getDatabase();
  const workspaceId = `bg-backfill-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  const definition = createWorkflowDefinitionSync({
    id: `${workspaceId}-def`,
    workspaceId,
    name: "BgBackfill",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const version = publishWorkflowVersionSync({
    id: `${workspaceId}-ver`,
    workspaceId,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:bgbackfill",
    publishedBy: "u1",
  });
  const suffixes = ["a", "b", "c", "d", "e"];
  const runs = suffixes.map((suffix, index) => createWorkflowRunSync({
    id: `${workspaceId}-run-${suffix}`,
    workspaceId,
    workflowId: definition.id,
    versionId: version.id,
    triggerType: "manual",
    triggerKey: `${workspaceId}:${suffix}`,
    inputJson: "{}",
    now: `2099-03-0${index + 1}T00:00:00.000Z`,
  }));

  // 模拟回填未完成：放开 NOT NULL，置 NULL，删 flag（强制后台重跑回填段）。
  db.exec("ALTER TABLE workflow_run ALTER COLUMN history_sequence DROP NOT NULL");
  db.prepare(`UPDATE workflow_run SET history_sequence = NULL WHERE id IN (?, ?, ?)`)
    .run(runs[0]!.id, runs[1]!.id, runs[2]!.id);
  db.prepare("DELETE FROM app_metadata WHERE key = ?").run(BACKFILL_FLAG);

  try {
    assert.equal(readFlag(), undefined, "前置：flag 已删除");
    assert.equal(
      historySequenceNullable(),
      "YES",
      "前置：history_sequence 已放开为可空",
    );

    await ensurePostgresConcurrentIndexes({});

    const nullCount = (
      db.prepare(
        "SELECT COUNT(*)::integer AS count FROM workflow_run WHERE workspace_id = ? AND history_sequence IS NULL",
      ).get(workspaceId) as { count: number }
    ).count;
    assert.equal(nullCount, 0, "回填后不得残留 NULL history_sequence");

    const sequences = db.prepare(
      `SELECT CAST(history_sequence AS bigint) AS seq FROM workflow_run
       WHERE workspace_id = ? ORDER BY history_sequence ASC`,
    ).all(workspaceId) as Array<{ seq: bigint }>;
    assert.deepEqual(
      sequences.map((row) => Number(row.seq)),
      [1, 2, 3, 4, 5],
      "回填序号按 (created_at, id) 单调分配",
    );

    const wsSeq = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq), 5, "workspace.workflow_run_sequence 推进到最大序号");

    assert.equal(historySequenceNullable(), "NO", "回填后 history_sequence 已恢复 NOT NULL");
    assert.equal(readFlag(), "true", "完成 flag 已置位");

    // 二次调用必须幂等：无 NULL、无异常、flag 仍 true、序号不变。
    await ensurePostgresConcurrentIndexes({});
    assert.equal(readFlag(), "true");
    const nullCount2 = (
      db.prepare(
        "SELECT COUNT(*)::integer AS count FROM workflow_run WHERE workspace_id = ? AND history_sequence IS NULL",
      ).get(workspaceId) as { count: number }
    ).count;
    assert.equal(nullCount2, 0, "二次调用不得引入 NULL");
  } finally {
    db.prepare("DELETE FROM workflow_run WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_version WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_definition WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
  }
});

/**
 * mock 后台自愈：flag 已完成时跳过回填段（不发 UPDATE/SET NOT NULL），仅确保索引。
 */
test("runBackgroundMaintenance：flag 已完成则跳过回填与 SET NOT NULL，仅建索引", async () => {
  const queries: string[] = [];
  const client: PostgresQueryClient = {
    async query(text: string) {
      queries.push(text);
      if (/SELECT value FROM app_metadata WHERE key/.test(text)) {
        return { rows: [{ value: "true" }] } as never;
      }
      return { rows: [] } as never;
    },
  };

  await runBackgroundMaintenanceForTests(client);

  assert.equal(
    queries.some((q) => /WHERE history_sequence IS NULL/.test(q)),
    false,
    "flag 已完成时不得再发回填 UPDATE",
  );
  assert.equal(
    queries.some((q) => /ALTER COLUMN history_sequence SET NOT NULL/.test(q)),
    false,
    "flag 已完成时不得再发 SET NOT NULL",
  );
  assert.ok(queries.some((q) => /CREATE INDEX CONCURRENTLY/.test(q)), "仍确保在线索引存在");
});

/**
 * mock 后台自愈：列已 NOT NULL 时跳过 SET NOT NULL（is_nullable 守卫），但仍回填 + 置 flag。
 */
test("runBackgroundMaintenance：列已 NOT NULL 时跳过 SET NOT NULL（is_nullable 守卫）", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client: PostgresQueryClient = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (/SELECT value FROM app_metadata WHERE key/.test(text)) {
        return { rows: [] } as never; // flag 未置
      }
      if (/information_schema.columns/.test(text)) {
        return { rows: [{ is_nullable: "NO" }] } as never; // 已 NOT NULL
      }
      return { rows: [] } as never;
    },
  };

  await runBackgroundMaintenanceForTests(client);

  assert.ok(
    queries.some((q) => /WHERE history_sequence IS NULL/.test(q.text)),
    "flag 未完成时须发回填 UPDATE",
  );
  assert.equal(
    queries.some((q) => q.text.includes(POSTGRES_HISTORY_SEQUENCE_SET_NOT_NULL_STATEMENT)),
    false,
    "列已 NOT NULL 时不得重复发 SET NOT NULL（AEL 全扫）",
  );
  assert.ok(
    queries.some(
      (q) => /INSERT INTO app_metadata/.test(q.text) && q.params?.[0] === BACKFILL_FLAG,
    ),
    "回填完成后须置 flag",
  );
});

test("后台自愈锁 117 与 schema 迁移锁 [115,116] 互不竞争", async () => {
  const url = resolvePostgresDatabaseUrl();
  const a = new Client({ connectionString: url });
  await a.connect();
  const b = new Client({ connectionString: url });
  await b.connect();
  try {
    // 1) a 持有 117 → b 仍能取得每个迁移锁（冷启动迁移不被长后台任务阻塞）。
    await a.query("SELECT pg_advisory_lock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      const result = await b.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [lockId],
      );
      assert.equal(result.rows[0]?.ok, true, `持有 117 时应仍能取迁移锁 ${lockId}`);
      await b.query("SELECT pg_advisory_unlock($1)", [lockId]);
    }
    await a.query("SELECT pg_advisory_unlock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);

    // 2) 反向：a 持有 [115,116] → b 仍能取得 117（长后台任务不被冷启动迁移阻塞）。
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await a.query("SELECT pg_advisory_lock($1)", [lockId]);
    }
    const r117 = await b.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID],
    );
    assert.equal(r117.rows[0]?.ok, true, "持有 [115,116] 时应仍能取后台锁 117");
    await b.query("SELECT pg_advisory_unlock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await a.query("SELECT pg_advisory_unlock($1)", [lockId]);
    }
  } finally {
    await b.end();
    await a.end();
  }
});
