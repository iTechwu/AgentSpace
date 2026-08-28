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
  POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT,
  POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS,
  POSTGRES_SCHEMA_ADVISORY_LOCK_IDS,
  getPostgresHistoryBackfillStatements,
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

  // 模拟回填未完成 + Spec #2 碰撞场景：放开 NOT NULL，把后 3 行（seq 3,4,5）置 NULL，
  // 保留前 2 行非空（seq 1,2）。计数器=5。旧 backfill（ROW_NUMBER 从 1 起）会给 NULL 行
  // 分配 1,2,3 → 与既存 1,2 碰撞重复。新 backfill 须从计数器续接（5+1,5+2,5+3=6,7,8），
  // 不与 1,2 碰撞。删 flag 强制后台重跑回填段。
  db.exec("ALTER TABLE workflow_run ALTER COLUMN history_sequence DROP NOT NULL");
  db.prepare(`UPDATE workflow_run SET history_sequence = NULL WHERE id IN (?, ?, ?)`)
    .run(runs[2]!.id, runs[3]!.id, runs[4]!.id);
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
    const seqNumbers = sequences.map((row) => Number(row.seq));
    // Spec #2：NULL 行得 6,7,8（从计数器 5 续接），非空行保留 1,2 → 全唯一、无碰撞。
    assert.deepEqual(
      seqNumbers,
      [1, 2, 6, 7, 8],
      "回填序号从计数器续接，不与既存非空序号碰撞（Spec #2）",
    );
    assert.equal(
      new Set(seqNumbers).size,
      seqNumbers.length,
      "序号集合无重复",
    );

    const wsSeq = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq), 8, "workspace.workflow_run_sequence 推进到最大序号 8");

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
 * Standards #1（原子性）：回填事务内对「有 NULL 行的 workspace」FOR UPDATE，持有至事务结束 →
 * 并发 INSERT 的 BEFORE INSERT 触发器（UPDATE workspace.workflow_run_sequence 取行锁）被阻塞，
 * 串行化分配，杜绝触发器在回填/计数器推进之间读到旧计数器分配出重复序号。
 * 用两个原始 pg 连接 + lock_timeout 确定性探测阻塞。
 */
test("回填事务的 workspace FOR UPDATE 阻塞并发 INSERT 触发器，串行化分配序号（Standards #1）", async () => {
  const db = getDatabase();
  const workspaceId = `bg-atomic-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  const definition = createWorkflowDefinitionSync({
    id: `${workspaceId}-def`,
    workspaceId,
    name: "Atomic",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const version = publishWorkflowVersionSync({
    id: `${workspaceId}-ver`,
    workspaceId,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:atomic",
    publishedBy: "u1",
  });
  const run = createWorkflowRunSync({
    id: `${workspaceId}-run-a`,
    workspaceId,
    workflowId: definition.id,
    versionId: version.id,
    triggerType: "manual",
    triggerKey: `${workspaceId}:a`,
    inputJson: "{}",
    now: "2099-04-01T00:00:00.000Z",
  });
  // run-a 得 seq 1，计数器=1。回填窗口：放开 NOT NULL，置 NULL（使 backfill CTE 的 EXISTS 锁定该 workspace）。
  db.exec("ALTER TABLE workflow_run ALTER COLUMN history_sequence DROP NOT NULL");
  db.prepare("UPDATE workflow_run SET history_sequence = NULL WHERE id = ?").run(run.id);

  const url = resolvePostgresDatabaseUrl();
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  const insertSql = `INSERT INTO workflow_run (id, workspace_id, workflow_id, version_id, trigger_type, trigger_key, input_json, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'manual', $5, '{}'::jsonb, 'test', '2099-04-02T00:00:00.000Z', '2099-04-02T00:00:00.000Z')`;
  try {
    // a 在事务内跑 backfill 首句（含 ws ... FOR UPDATE），锁定该 workspace 行持有至 COMMIT/ROLLBACK。
    await a.query("BEGIN");
    const backfillSql = getPostgresHistoryBackfillStatements()[0]!;
    await a.query(backfillSql);

    // b 并发 INSERT：BEFORE INSERT 触发器 UPDATE workspace 取行锁 → 被 a 的 FOR UPDATE 阻塞 → lock_timeout。
    await b.query("SET lock_timeout = '500ms'");
    await assert.rejects(
      b.query(insertSql, [`${workspaceId}-run-b`, workspaceId, definition.id, version.id, `${workspaceId}:b`]),
      /lock timeout|could not obtain lock/i,
      "回填事务持锁期间，并发 INSERT 触发器须被阻塞（FOR UPDATE 串行化）",
    );

    // a 释放锁后，b 重试 INSERT 成功。
    await a.query("ROLLBACK");
    const res = await b.query(insertSql, [`${workspaceId}-run-b2`, workspaceId, definition.id, version.id, `${workspaceId}:b2`]);
    assert.equal(res.rowCount, 1, "锁释放后并发 INSERT 成功");

    const seqs = db.prepare(
      `SELECT CAST(history_sequence AS bigint) AS seq FROM workflow_run WHERE workspace_id = ?`,
    ).all(workspaceId) as Array<{ seq: bigint | null }>;
    const nonNull = seqs.filter((r) => r.seq !== null).map((r) => Number(r.seq));
    assert.equal(new Set(nonNull).size, nonNull.length, "已分配序号无重复");
  } finally {
    await b.end();
    await a.end();
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
    queries.some((q) => /history_sequence IS NULL/.test(q)),
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
 * 分批流程（Issue 7）：先查待回填 workspace（返回一个触发回填批次，再返回空终止循环），每批独立事务。
 */
test("runBackgroundMaintenance：列已 NOT NULL 时跳过 SET NOT NULL（is_nullable 守卫）", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  let pendingReturned = false;
  const client: PostgresQueryClient = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (/SELECT value FROM app_metadata WHERE key/.test(text)) {
        return { rows: [] } as never; // flag 未置
      }
      if (/SELECT DISTINCT workspace_id/.test(text)) {
        // 首次返回一个待回填 workspace 触发回填批次；之后返回空终止循环。
        if (!pendingReturned) {
          pendingReturned = true;
          return { rows: [{ workspace_id: "ws-mock" }] } as never;
        }
        return { rows: [] } as never;
      }
      if (/information_schema.columns/.test(text)) {
        return { rows: [{ is_nullable: "NO" }] } as never; // 已 NOT NULL
      }
      return { rows: [] } as never;
    },
  };

  await runBackgroundMaintenanceForTests(client);

  assert.ok(
    queries.some((q) => /history_sequence = ranked\.sequence/.test(q.text)),
    "flag 未完成时须发回填 UPDATE（分批）",
  );
  // 回填批次须独立事务提交（BEGIN…COMMIT），而非与 NOT NULL 混在一个事务。
  assert.ok(queries.some((q) => q.text === "BEGIN"), "回填批次须在事务内");
  assert.ok(queries.some((q) => q.text === "COMMIT"), "回填批次须独立提交");
  // 列已 NOT NULL 时跳过在线 NOT NULL 语句（is_nullable 守卫避免冗余 DDL/VALIDATE 全扫）。
  assert.equal(
    queries.some((q) => /ALTER COLUMN history_sequence SET NOT NULL/.test(q.text)),
    false,
    "列已 NOT NULL 时不得重复发在线 NOT NULL 语句",
  );
  assert.ok(
    queries.some(
      (q) => /INSERT INTO app_metadata/.test(q.text) && q.params?.[0] === BACKFILL_FLAG,
    ),
    "回填完成后须置 flag",
  );
});

/**
 * Issue 7（分批回填）：runBackgroundMaintenance 按 workspace 受限批次逐批独立事务提交，每批只锁本批
 * workspace（持有至该批 COMMIT）。mock 注入 3 个待回填 workspace、批次上限 2 → 须分两批（[w1,w2]、[w3]），
 * 每批各自 BEGIN…backfill…advance…COMMIT，证明全量回填被拆成受限批次而非单事务锁住全部 workspace。
 */
test("runBackgroundMaintenance 分批回填：每批 workspace 独立事务提交（Issue 7）", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const batches = [["ws-a", "ws-b"], ["ws-c"]];
  let pendingIndex = 0;
  const client: PostgresQueryClient = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (/SELECT value FROM app_metadata WHERE key/.test(text)) {
        return { rows: [] } as never; // flag 未置
      }
      if (/SELECT DISTINCT workspace_id/.test(text)) {
        return { rows: (batches[pendingIndex++] ?? []).map((workspace_id) => ({ workspace_id })) } as never;
      }
      if (/information_schema.columns/.test(text)) {
        return { rows: [{ is_nullable: "NO" }] } as never; // 已 NOT NULL，跳过 NOT NULL 段
      }
      return { rows: [] } as never;
    },
  };

  await runBackgroundMaintenanceForTests(client, { batchLimit: 2 });

  // 两批回填，每批一次 BEGIN + backfill（$1=该批 workspace 数组）+ advance + COMMIT。
  const backfillCalls = queries.filter((q) => /history_sequence = ranked\.sequence/.test(q.text));
  assert.equal(backfillCalls.length, 2, "须分两批回填");
  assert.deepEqual(backfillCalls[0]!.params, [["ws-a", "ws-b"]], "第一批回填限定 ws-a/ws-b");
  assert.deepEqual(backfillCalls[1]!.params, [["ws-c"]], "第二批回填限定 ws-c");
  const begins = queries.filter((q) => q.text === "BEGIN").length;
  const commits = queries.filter((q) => q.text === "COMMIT").length;
  assert.equal(begins, 2, "每批回填独立 BEGIN");
  assert.equal(commits, 2, "每批回填独立 COMMIT（不持锁跨批）");
});

/**
 * Issue 7（分批回填，真库）：3 个 workspace 各有 NULL 行，批次上限 2 → 分两批提交。断言每个 workspace
 * 的序号从其计数器续接、无碰撞、计数器推进到最大值，且全部 NULL 行清空、flag 置位——证明分批回填
 * 与原单事务回填产生一致的终态。
 */
test("分批回填多 workspace 产生续接且无碰撞的序号（Issue 7 真库）", async () => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceIds = ["ws-chunk-1", "ws-chunk-2", "ws-chunk-3"].map((id) => `${id}-${Math.random().toString(36).slice(2, 6)}`);
  const createdDefinitionIds: string[] = [];
  try {
    db.exec("ALTER TABLE workflow_run ALTER COLUMN history_sequence DROP NOT NULL");
    db.prepare("DELETE FROM app_metadata WHERE key = ?").run(BACKFILL_FLAG);
    // 每个 workspace 种入 2 行 run（history_sequence 置 NULL，计数器=0）。
    for (const [idx, workspaceId] of workspaceIds.entries()) {
      db.prepare(
        `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'test', ?, ?)`,
      ).run(workspaceId, workspaceId, workspaceId, now, now);
      const definition = createWorkflowDefinitionSync({
        id: `${workspaceId}-def`,
        workspaceId,
        name: "Chunk",
        ownerUserId: "u1",
        createdBy: "u1",
      });
      createdDefinitionIds.push(definition.id);
      const version = publishWorkflowVersionSync({
        id: `${workspaceId}-ver`,
        workspaceId,
        workflowId: definition.id,
        graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
        contentHash: `sha256:${workspaceId}`,
        publishedBy: "u1",
      });
      for (const suffix of ["x", "y"]) {
        createWorkflowRunSync({
          id: `${workspaceId}-run-${suffix}`,
          workspaceId,
          workflowId: definition.id,
          versionId: version.id,
          triggerType: "manual",
          triggerKey: `${workspaceId}:${suffix}`,
          inputJson: "{}",
          now: `2099-05-0${suffix === "x" ? 1 : 2}T00:00:00.000Z`,
        });
      }
      db.prepare(`UPDATE workflow_run SET history_sequence = NULL WHERE workspace_id = ?`).run(workspaceId);
      db.prepare(`UPDATE workspace SET workflow_run_sequence = 0 WHERE id = ?`).run(workspaceId);
      void idx;
    }

    await ensurePostgresConcurrentIndexes({});

    for (const workspaceId of workspaceIds) {
      const seqs = db.prepare(
        `SELECT CAST(history_sequence AS bigint) AS seq FROM workflow_run
          WHERE workspace_id = ? ORDER BY history_sequence ASC`,
      ).all(workspaceId) as Array<{ seq: bigint }>;
      const seqNumbers = seqs.map((row) => Number(row.seq));
      assert.deepEqual(seqNumbers, [1, 2], `${workspaceId}: 分批回填后序号续接为 1,2`);
      const wsSeq = (db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }).seq;
      assert.equal(Number(wsSeq), 2, `${workspaceId}: 计数器推进到 2`);
    }
    assert.equal(readFlag(), "true", "分批回填完成后须置 flag");
  } finally {
    for (const workspaceId of workspaceIds) {
      db.prepare("DELETE FROM workflow_run WHERE workspace_id = ?").run(workspaceId);
    }
    for (const defId of createdDefinitionIds) {
      db.prepare("DELETE FROM workflow_version WHERE workflow_id = ?").run(defId);
      db.prepare("DELETE FROM workflow_definition WHERE id = ?").run(defId);
    }
    for (const workspaceId of workspaceIds) {
      db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
    }
  }
});

/**
 * Standards #1（全局计数器修复）：分批 advance 只覆盖「曾有 NULL 行」而被 pending 查询选中的 workspace。
 * 旧版本可能已回填某 workspace 的 history_sequence（无 NULL 行）却未推进其 workflow_run_sequence 计数器——
 * 这类 workspace 永不进批，计数器停滞 → BEFORE INSERT 触发器后续分配的序号会与既有高序号碰撞。修复：
 * 分批回填后对所有 workspace 做一次全局 GREATEST 推进。本用例种子一个「无 NULL 行、计数器停滞」的
 * workspace，断言 ensurePostgresConcurrentIndexes 把它的计数器推进到最大 history_sequence。
 */
test("全局计数器修复推进停滞计数器（已回填但计数器未推进，无 NULL 行）", async () => {
  const db = getDatabase();
  const workspaceId = `bg-counter-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(workspaceId, workspaceId, workspaceId, now, now);
    const definition = createWorkflowDefinitionSync({
      id: `${workspaceId}-def`,
      workspaceId,
      name: "CounterRepair",
      ownerUserId: "u1",
      createdBy: "u1",
    });
    const version = publishWorkflowVersionSync({
      id: `${workspaceId}-ver`,
      workspaceId,
      workflowId: definition.id,
      graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
      contentHash: `sha256:${workspaceId}`,
      publishedBy: "u1",
    });
    // 三行 run，手动赋予非空 history_sequence 10/20/30（模拟旧版本已回填序号）。
    const sequences = [10, 20, 30];
    for (const [index, seq] of sequences.entries()) {
      const run = createWorkflowRunSync({
        id: `${workspaceId}-run-${index}`,
        workspaceId,
        workflowId: definition.id,
        versionId: version.id,
        triggerType: "manual",
        triggerKey: `${workspaceId}:${index}`,
        inputJson: "{}",
        now: `2099-06-0${index + 1}T00:00:00.000Z`,
      });
      db.prepare("UPDATE workflow_run SET history_sequence = ? WHERE id = ?").run(seq, run.id);
    }
    // 计数器人为停滞在 5（< max 30），模拟旧版本回填了序号却未推进计数器。本 workspace 无 NULL 行
    // → 永不被分批回填选中，只有全局计数器修复能推进。删 flag 强制后台重跑回填段（含全局修复）。
    db.prepare("UPDATE workspace SET workflow_run_sequence = 5 WHERE id = ?").run(workspaceId);
    db.prepare("DELETE FROM app_metadata WHERE key = ?").run(BACKFILL_FLAG);

    await ensurePostgresConcurrentIndexes({});

    const wsSeq = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq), 30, "停滞计数器须被全局修复推进到最大 history_sequence 30");

    // 幂等：二次运行（flag 已置）不再变动计数器。
    await ensurePostgresConcurrentIndexes({});
    const wsSeq2 = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq2), 30, "二次运行计数器保持 30（幂等）");
    assert.equal(readFlag(), "true", "回填完成后须置 flag");
  } finally {
    db.prepare("DELETE FROM workflow_run WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_version WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_definition WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
    // 复原 flag（测试库已完成回填）。
    db.prepare(
      `INSERT INTO app_metadata (key, value) VALUES (?, 'true')
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ).run(BACKFILL_FLAG);
  }
});

/**
 * 全局计数器修复语句本身（隔离验证）：种子停滞计数器后直接执行语句，断言推进到 max 且幂等。
 */
test("POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT 推进停滞计数器且幂等", () => {
  const db = getDatabase();
  const workspaceId = `bg-counter-stmt-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(workspaceId, workspaceId, workspaceId, now, now);
    const definition = createWorkflowDefinitionSync({
      id: `${workspaceId}-def`,
      workspaceId,
      name: "CounterStmt",
      ownerUserId: "u1",
      createdBy: "u1",
    });
    const version = publishWorkflowVersionSync({
      id: `${workspaceId}-ver`,
      workspaceId,
      workflowId: definition.id,
      graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
      contentHash: `sha256:stmt-${workspaceId}`,
      publishedBy: "u1",
    });
    for (const [index, seq] of [10, 20, 30].entries()) {
      const run = createWorkflowRunSync({
        id: `${workspaceId}-run-${index}`,
        workspaceId,
        workflowId: definition.id,
        versionId: version.id,
        triggerType: "manual",
        triggerKey: `${workspaceId}:${index}`,
        inputJson: "{}",
        now: `2099-07-0${index + 1}T00:00:00.000Z`,
      });
      db.prepare("UPDATE workflow_run SET history_sequence = ? WHERE id = ?").run(seq, run.id);
    }
    db.prepare("UPDATE workspace SET workflow_run_sequence = 5 WHERE id = ?").run(workspaceId);

    db.prepare(POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT).run();

    const wsSeq = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq), 30, "停滞计数器须推进到最大 history_sequence");

    // 已正确 → 二次执行 no-op。
    db.prepare(POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT).run();
    const wsSeq2 = (
      db.prepare("SELECT CAST(workflow_run_sequence AS bigint) AS seq FROM workspace WHERE id = ?").get(workspaceId) as { seq: bigint }
    ).seq;
    assert.equal(Number(wsSeq2), 30, "计数器已正确时语句为 no-op");
  } finally {
    db.prepare("DELETE FROM workflow_run WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_version WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workflow_definition WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
  }
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
