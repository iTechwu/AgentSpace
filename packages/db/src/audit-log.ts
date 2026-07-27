import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { AuditLogRecord, AuditLogSource } from "./types.ts";

export interface RecordAuditLogInput {
  workspaceId?: string;
  title: string;
  note: string;
  code?: string;
  source?: AuditLogSource;
  data?: Record<string, unknown>;
}

/**
 * Append an immutable row to the `audit_log` table. Used for credential/key
 * and runtime-lifecycle events that require a tamper-evident record (the
 * mutable `workspace_state.ledger` is not sufficient). Never store plaintext
 * keys — only fingerprints and opaque references in `data`.
 */
export function recordAuditLogSync(input: RecordAuditLogInput): AuditLogRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `audit-${randomLikeId()}`;
  const now = new Date().toISOString();
  const dataJson = JSON.stringify(input.data ?? {});
  getDatabase().prepare(
    `INSERT INTO audit_log (id, workspace_id, title, note, code, data_json, source, source_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    workspaceId,
    input.title,
    input.note,
    input.code ?? null,
    dataJson,
    input.source ?? "runtime_lifecycle",
    now,
  );
  return readAuditLogSync(id, workspaceId)!;
}

export function readAuditLogSync(
  id: string,
  workspaceId?: string,
): AuditLogRecord | null {
  const row = (workspaceId
    ? getDatabase().prepare(
        "SELECT * FROM audit_log WHERE id = ? AND workspace_id = ?",
      ).get(id, workspaceId)
    : getDatabase().prepare("SELECT * FROM audit_log WHERE id = ?").get(id)) as
    | RawAuditLog
    | undefined;
  return row ? mapAuditLog(row) : null;
}

export function listAuditLogsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  options?: { source?: AuditLogSource; code?: string; limit?: number },
): AuditLogRecord[] {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const clauses = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options?.source) {
    clauses.push("source = ?");
    params.push(options.source);
  }
  if (options?.code) {
    clauses.push("code = ?");
    params.push(options.code);
  }
  params.push(limit);
  const rows = getDatabase().prepare(
    `SELECT * FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params) as RawAuditLog[];
  return rows.map(mapAuditLog);
}

type RawAuditLog = {
  id: string;
  workspace_id: string;
  title: string;
  note: string;
  code: string | null;
  data_json: string;
  source: AuditLogSource;
  source_index: number;
  created_at: string;
};

function mapAuditLog(row: RawAuditLog): AuditLogRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    note: row.note,
    code: row.code ?? undefined,
    dataJson: row.data_json,
    source: row.source,
    sourceIndex: row.source_index,
    createdAt: row.created_at,
  };
}
