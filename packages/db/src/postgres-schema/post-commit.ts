// post-commit 在线索引（CONCURRENTLY）语句与索引名。源自 postgres-schema.ts 源行 4836-4878。
/**
 * 运行历史在线索引名。无法放入 schema 主事务（CREATE INDEX CONCURRENTLY 不允许在事务块内），
 * 因此由独立的后台/迁移路径在事务外构建。保留旧索引，避免重建时阻塞 workflow_run 写入；
 * 新索引完成前查询仍可正确使用旧索引前缀。
 */
export const POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME = "idx_workflow_run_workspace_created_v2";

/**
 * history_sequence keyset 分页专用索引名。同 POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME 一样
 * 以 CREATE INDEX CONCURRENTLY 在事务外构建（普通 CREATE INDEX 取 ACCESS EXCLUSIVE 锁阻塞
 * workflow_run 写入，故移出主事务）。失败遗留的无效索引由 applyPostCommitSchemaStatements
 * 在重建前用 DROP INDEX CONCURRENTLY 清理。
 */
export const POSTGRES_WORKFLOW_RUN_HISTORY_SEQUENCE_INDEX_NAME =
  "idx_workflow_run_workspace_history_sequence";

/**
 * 所有 post-commit 在线索引名。applyPostCommitSchemaStatements 据此逐个检查 pg_index 状态，
 * 无效（失败 CONCURRENTLY 遗留）则先 DROP INDEX CONCURRENTLY 再重建，避免 IF NOT EXISTS 因
 * 「索引已存在（哪怕无效）」而永久跳过坏索引。
 */
export const POSTGRES_POST_COMMIT_INDEX_NAMES = [
  POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME,
  POSTGRES_WORKFLOW_RUN_HISTORY_SEQUENCE_INDEX_NAME,
] as const;

/**
 * 不能放入 schema 主事务的在线索引语句（仅幂等 CREATE）。无效索引的清理（DROP INDEX
 * CONCURRENTLY）由 applyPostCommitSchemaStatements 在事务外按 pg_index 状态条件执行，
 * 避免在 DO 块内用普通 DROP INDEX 取 ACCESS EXCLUSIVE 锁阻塞业务写入。
 */
export function getPostgresPostCommitSchemaStatements(): string[] {
  return [
    `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME}
        ON workflow_run(workspace_id, created_at DESC, id DESC)
    `,
    `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${POSTGRES_WORKFLOW_RUN_HISTORY_SEQUENCE_INDEX_NAME}
        ON workflow_run(workspace_id, history_sequence)
    `,
  ].map((statement) => statement.trim());
}
