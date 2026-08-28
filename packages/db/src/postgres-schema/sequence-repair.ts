// workflow_run history_sequence 计数器自愈与在线 NOT NULL 迁移语句。源自 postgres-schema.ts 源行 4788-4835。
/**
 * 全局计数器修复（不分批、不限 workspace）：把每个 workspace 的 workflow_run_sequence 推进到至少
 * 等于其 workflow_run 已分配的最大 history_sequence。分批 advance 只覆盖「曾有 NULL 行」而被分批的
 * workspace；旧版本可能已回填某些 workspace 的 history_sequence（无 NULL 行）却未推进计数器——这类
 * workspace 不会被 POSTGRES_HISTORY_BACKFILL_PENDING_WORKSPACES_QUERY 选中、永不进批，计数器停滞，
 * 触发器后续分配的序号会与既有高序号碰撞（重复序号）。WHERE < max 使计数器已正确者成为 no-op，
 * 全语句幂等，可在每次后台自愈重跑。无 `$1` 参数。
 */
export const POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT = `
  UPDATE workspace AS target
     SET workflow_run_sequence = GREATEST(target.workflow_run_sequence, source.max_sequence)
    FROM (
      SELECT workspace_id, MAX(history_sequence) AS max_sequence
        FROM workflow_run
       WHERE history_sequence IS NOT NULL
       GROUP BY workspace_id
    ) AS source
   WHERE target.id = source.workspace_id
     AND target.workflow_run_sequence < source.max_sequence`;

/**
 * 回填完成后把 history_sequence 设为 NOT NULL。依赖「无 NULL 行」——分配触发器保证新写入非空、
 * 回填 UPDATE 清掉旧 NULL 后才可施加。维护/迁移路径直接运行；后台自愈仅在列仍可空时运行
 * （用 information_schema.columns.is_nullable 守卫，避免每次冷启动重复 AEL 全扫）。
 */
export const POSTGRES_HISTORY_SEQUENCE_SET_NOT_NULL_STATEMENT =
  "ALTER TABLE workflow_run ALTER COLUMN history_sequence SET NOT NULL";

/**
 * history_sequence 在线设 NOT NULL 的语句序列（替代单条 SET NOT NULL，避免大表强锁全扫）。
 * 1) ADD CHECK ... NOT VALID：只约束未来写入，瞬时锁，不校验存量行。
 * 2) VALIDATE CONSTRAINT：SHARE UPDATE EXCLUSIVE，不阻塞并发写入，校验存量行。
 * 3) SET NOT NULL：PG12+ 在已有 valid CHECK 时不重扫全表，仅瞬时列锁。
 * 4) DROP CONSTRAINT：NOT NULL 已生效，CHECK 冗余，清理。
 * 全部可在事务块内执行（不像 CREATE INDEX CONCURRENTLY），故可与回填同事务原子完成。
 * 幂等：ADD 用 DO/EXCEPTION 守卫 duplicate_object；VALIDATE 对已 valid 约束为 no-op；
 *       SET NOT NULL 对已 NOT NULL 列为 no-op；DROP IF EXISTS 安全。
 */
export const POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS: string[] = [
  `DO $$ BEGIN
    ALTER TABLE workflow_run ADD CONSTRAINT workflow_run_history_sequence_not_null
      CHECK (history_sequence IS NOT NULL) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  "ALTER TABLE workflow_run VALIDATE CONSTRAINT workflow_run_history_sequence_not_null",
  "ALTER TABLE workflow_run ALTER COLUMN history_sequence SET NOT NULL",
  "ALTER TABLE workflow_run DROP CONSTRAINT IF EXISTS workflow_run_history_sequence_not_null",
].map((statement) => statement.trim());

