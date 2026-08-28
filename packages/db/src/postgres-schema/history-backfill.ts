// history_sequence 回填与分批推进语句。源自 postgres-schema.ts 源行 4671-4787。
/**
 * history_sequence 回填语句（事务安全）：把仍为 NULL 的旧行按 (workspace_id, created_at, id)
 * 排序分配序号，再把每个 workspace 的 workflow_run_sequence 推进到已有最大序号。幂等——
 * WHERE history_sequence IS NULL 使干净库为 no-op；分配触发器保证回填后新写入行的序号必大于
 * 已回填的最大值，不会回卷。维护/迁移路径在主事务内同步运行；运行时由后台自愈异步运行。
 */
export function getPostgresHistoryBackfillStatements(): string[] {
  return [
    // 原子回填：先 FOR UPDATE 锁住"仍有 NULL history_sequence 行"的 workspace 行（持有至事务结束），
    // 使并发 INSERT 的分配触发器（BEFORE INSERT，靠 UPDATE workspace.workflow_run_sequence 取行锁）
    // 阻塞——把"给旧行编号"与"推进计数器"在同一事务内串行化，杜绝触发器在两步之间从旧计数器
    // 分配出与回填序号碰撞的重复序号（Spec #2）。BEFORE INSERT 阶段新行尚未落表，故不与本 UPDATE
    // 死锁；只锁相关 workspace，最小阻塞。序号从该 workspace 当前计数器续接（counter + ROW_NUMBER），
    // 绝不与已分配的非空序号碰撞（旧实现从 1 起编号会与触发器已分配的低序号重复）。
    `
      WITH ws AS (
        SELECT w.id AS workspace_id, w.workflow_run_sequence
          FROM workspace w
         WHERE EXISTS (
           SELECT 1 FROM workflow_run r
            WHERE r.workspace_id = w.id AND r.history_sequence IS NULL
         )
         FOR UPDATE
      ), ranked AS (
        SELECT r.id,
               ws.workflow_run_sequence
                 + ROW_NUMBER() OVER (PARTITION BY r.workspace_id ORDER BY r.created_at ASC, r.id ASC) AS sequence
          FROM workflow_run r
          JOIN ws ON ws.workspace_id = r.workspace_id
         WHERE r.history_sequence IS NULL
      )
      UPDATE workflow_run AS run
         SET history_sequence = ranked.sequence
        FROM ranked
       WHERE run.id = ranked.id
    `,
    `
      UPDATE workspace AS target
         SET workflow_run_sequence = GREATEST(
           target.workflow_run_sequence,
           COALESCE(source.max_sequence, 0)
         )
        FROM (
          SELECT workspace_id, MAX(history_sequence) AS max_sequence
            FROM workflow_run
           GROUP BY workspace_id
        ) AS source
       WHERE target.id = source.workspace_id
    `,
  ].map((statement) => statement.trim());
}

/**
 * 分批回填的每批 workspace 上限。runBackgroundMaintenance 以此为限逐批取「仍有 NULL history_sequence
 * 行」的 workspace，每批独立事务提交——避免一次性 FOR UPDATE 锁住所有待迁移 workspace、持锁经过
 * 全量回填与 NOT NULL，长时间阻塞这些 workspace 的新 Run 创建（Issue 7）。50 在百万级旧行下把单批
 * 锁持有时长控制在秒级，且总进度随每批提交可见。
 */
export const POSTGRES_HISTORY_BACKFILL_BATCH_WORKSPACE_LIMIT = 50;

/**
 * 列出仍有 NULL history_sequence 行的 workspace（受限批次，按 id 排序保证确定性进度），供分批回填。
 * `$1` = 批次上限。新写入行由 BEFORE INSERT 分配触发器即时获得非空序号，故本查询只命中待回填旧行。
 */
export const POSTGRES_HISTORY_BACKFILL_PENDING_WORKSPACES_QUERY = `
  SELECT DISTINCT workspace_id
    FROM workflow_run
   WHERE history_sequence IS NULL
   ORDER BY workspace_id
   LIMIT $1`;

/**
 * 给定一批 workspace id（`$1` = text[]），返回 { backfill, advance } 两条参数化语句。与
 * getPostgresHistoryBackfillStatements 同源，但 `ws ... FOR UPDATE` 与计数器推进都限定在 `$1` 这批
 * workspace 内——每批事务只锁这批 workspace（持有至该批 COMMIT），把全量回填拆成受限批次，避免
 * 长时间阻塞所有待迁移 workspace 的新 Run 创建（Issue 7）。幂等（WHERE history_sequence IS NULL）。
 */
export function getPostgresHistoryBackfillStatementsForWorkspaces(): { backfill: string; advance: string } {
  return {
    backfill: `
      WITH ws AS (
        SELECT w.id AS workspace_id, w.workflow_run_sequence
          FROM workspace w
         WHERE w.id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM workflow_run r
              WHERE r.workspace_id = w.id AND r.history_sequence IS NULL
           )
         FOR UPDATE
      ), ranked AS (
        SELECT r.id,
               ws.workflow_run_sequence
                 + ROW_NUMBER() OVER (PARTITION BY r.workspace_id ORDER BY r.created_at ASC, r.id ASC) AS sequence
          FROM workflow_run r
          JOIN ws ON ws.workspace_id = r.workspace_id
         WHERE r.history_sequence IS NULL
      )
      UPDATE workflow_run AS run
         SET history_sequence = ranked.sequence
        FROM ranked
       WHERE run.id = ranked.id`,
    advance: `
      UPDATE workspace AS target
         SET workflow_run_sequence = GREATEST(
           target.workflow_run_sequence,
           COALESCE(source.max_sequence, 0)
         )
        FROM (
          SELECT workspace_id, MAX(history_sequence) AS max_sequence
            FROM workflow_run
           WHERE workspace_id = ANY($1::text[])
           GROUP BY workspace_id
        ) AS source
       WHERE target.id = source.workspace_id`,
  };
}

