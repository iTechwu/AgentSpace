import assert from "node:assert/strict";
import test from "node:test";
import {
  getPostgresPostCommitSchemaStatements,
  getPostgresSchemaStatements,
} from "../postgres-schema.ts";

const WORKFLOW_TABLES = [
  "workflow_definition",
  "workflow_version",
  "workflow_trigger",
  "workflow_run",
  "workflow_node_run",
  "workflow_run_event",
  "workflow_outbox",
] as const;

test("workflow schema contains tenant-safe relations and idempotency constraints", () => {
  const sql = getPostgresSchemaStatements().join("\n");

  for (const table of WORKFLOW_TABLES) {
    const tableSql = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\)`, "i"))?.[1];
    assert.ok(tableSql, `missing ${table}`);
    assert.match(
      tableSql,
      /workspace_id TEXT NOT NULL REFERENCES workspace\(id\) ON DELETE CASCADE/i,
      `${table} must be workspace scoped`,
    );
  }

  assert.match(sql, /UNIQUE\s*\(workspace_id, trigger_key\)/i);
  assert.match(sql, /UNIQUE\s*\(run_id, node_id\)/i);
  assert.match(sql, /UNIQUE\s*\(run_id, sequence\)/i);
  assert.match(sql, /draft_graph_json JSONB NOT NULL/i);
  assert.match(sql, /draft_version INTEGER NOT NULL DEFAULT 1/i);
  assert.match(sql, /idx_workflow_trigger_due[\s\S]*WHERE status = 'active'/i);
  assert.match(sql, /idx_workflow_node_run_ready[\s\S]*WHERE status IN \('ready', 'retry_wait'\)/i);
  assert.match(sql, /idx_workflow_outbox_due[\s\S]*WHERE status = 'pending'/i);
  // history_sequence keyset 索引移至 post-commit 在线索径（CONCURRENTLY，不阻塞 workflow_run 写入）。
  const postCommitSql = getPostgresPostCommitSchemaStatements().join("\n");
  assert.match(
    postCommitSql,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_run_workspace_history_sequence[\s\S]*workflow_run\(workspace_id, history_sequence\)/i,
  );
  assert.match(sql, /idx_workflow_run_workspace_created[\s\S]*workflow_run\(workspace_id, created_at DESC, id DESC\)/i);
});
