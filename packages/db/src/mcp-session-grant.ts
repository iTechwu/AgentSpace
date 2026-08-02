import { getDatabase, DEFAULT_WORKSPACE_ID, withTransaction } from "./database.ts";

export interface McpTaskSessionGrantRecord {
  taskId: string;
  workspaceId: string;
  runtimeId: string;
  attemptId: string;
  /** Encrypted (AES-256-GCM) resolved MCP connection bundle, plaintext daemon-only. */
  encryptedBundleJson: string;
  expiresAt: string;
  createdAt: string;
}

export interface WriteMcpTaskSessionGrantInput {
  workspaceId?: string;
  runtimeId: string;
  taskId: string;
  attemptId: string;
  encryptedBundleJson: string;
  expiresAt: string;
}

// Keep the raw snake_case column names: the worker's normalizeRowKey converts
// them to camelCase (task_id → taskId), while an `AS taskId` alias would come
// back lower-cased (taskid) and miss the alias map, breaking the mapper.
const MCP_TASK_SESSION_GRANT_COLUMNS = `SELECT
  task_id, workspace_id, runtime_id, attempt_id, encrypted_bundle_json, expires_at, created_at`;

/**
 * Persists a task's MCP session grant. The grant carries the ENCRYPTED resolved
 * bundle (endpoint + secrets stay out of plaintext rows) plus a TTL, so the
 * idempotency key survives control-plane restarts and the snapshot is destroyed
 * by the TTL sweep / task-end cleanup instead of living in an unbounded in-memory
 * cache.
 *
 * `ON CONFLICT DO NOTHING`: the first claim wins; a caller that lost its response
 * reads the existing grant back via readMcpTaskSessionGrantSync.
 */
export function writeMcpTaskSessionGrantSync(input: WriteMcpTaskSessionGrantInput): McpTaskSessionGrantRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO mcp_task_session_grant (
       task_id, workspace_id, runtime_id, attempt_id, encrypted_bundle_json, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO NOTHING`,
  ).run(
    input.taskId,
    workspaceId,
    input.runtimeId,
    input.attemptId,
    input.encryptedBundleJson,
    input.expiresAt,
    now,
  );
  const record = readMcpTaskSessionGrantSync(input.taskId, workspaceId);
  if (!record) {
    throw new Error("Failed to write MCP task session grant.");
  }
  return record;
}

/**
 * Atomically consumes the one-time claim marker and persists the grant in ONE
 * transaction. If the marker was already consumed, the grant INSERT is skipped
 * and `claimed` is false — there is never a window where the marker is consumed
 * but the grant is missing (which would leave a permanent empty authorization
 * after a crash between the two old statements).
 */
export function claimMcpTaskSessionAtomicallySync(input: {
  taskId: string;
  workspaceId?: string;
  runtimeId: string;
  attemptId: string;
  encryptedBundleJson: string;
  expiresAt: string;
}): { claimed: boolean } {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  let claimed = false;
  withTransaction(db, () => {
    const now = new Date().toISOString();
    const marker = db.prepare(
      `UPDATE agent_task_queue
       SET mcp_session_claimed_at = ?, updated_at = ?
       WHERE id = ? AND mcp_session_claimed_at IS NULL`,
    ).run(now, now, input.taskId);
    if (marker.changes > 0) {
      db.prepare(
        `INSERT INTO mcp_task_session_grant (
           task_id, workspace_id, runtime_id, attempt_id, encrypted_bundle_json, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO NOTHING`,
      ).run(
        input.taskId,
        workspaceId,
        input.runtimeId,
        input.attemptId,
        input.encryptedBundleJson,
        input.expiresAt,
        now,
      );
      claimed = true;
    }
  });
  return { claimed };
}

export function readMcpTaskSessionGrantSync(
  taskId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): McpTaskSessionGrantRecord | null {
  const row = getDatabase().prepare(
    `${MCP_TASK_SESSION_GRANT_COLUMNS} FROM mcp_task_session_grant
     WHERE task_id = ? AND workspace_id = ?`,
  ).get(taskId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return mapMcpTaskSessionGrantRecord(row);
}

export function deleteMcpTaskSessionGrantSync(taskId: string, workspaceId = DEFAULT_WORKSPACE_ID): void {
  getDatabase().prepare(
    "DELETE FROM mcp_task_session_grant WHERE task_id = ? AND workspace_id = ?",
  ).run(taskId, workspaceId);
}

/** Removes grants whose TTL has elapsed. Returns the number removed. */
export function deleteExpiredMcpTaskSessionGrantsSync(now = new Date().toISOString()): number {
  const result = getDatabase().prepare(
    "DELETE FROM mcp_task_session_grant WHERE expires_at <= ?",
  ).run(now);
  return result.changes;
}

function mapMcpTaskSessionGrantRecord(value: Record<string, unknown>): McpTaskSessionGrantRecord | null {
  if (
    typeof value.taskId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.attemptId !== "string" ||
    typeof value.encryptedBundleJson !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    taskId: value.taskId,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    attemptId: value.attemptId,
    encryptedBundleJson: value.encryptedBundleJson,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
  };
}
