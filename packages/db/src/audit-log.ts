import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import {
  assertAuditLogIdempotencyMatch,
  canonicalizeAuditLogDataJson,
  resolveAuditLogWrite,
} from "./audit-log-idempotency.ts";
import type { AuditLogRecord, AuditLogSource } from "./types.ts";

export interface RecordAuditLogInput {
  workspaceId?: string;
  idempotencyKey?: string;
  title: string;
  note: string;
  code?: string;
  source?: AuditLogSource;
  data?: Record<string, unknown>;
}

export interface AuditLogListOptions {
  source?: AuditLogSource;
  code?: string;
  actorId?: string;
  employeeId?: string;
  runtimeId?: string;
  sessionId?: string;
  taskId?: string;
  modelId?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
}

/**
 * Append an immutable row to the `audit_log` table. Used for credential/key
 * and runtime-lifecycle events that require a tamper-evident record (the
 * mutable `workspace_state.ledger` is not sufficient). Never store plaintext
 * keys — only fingerprints and opaque references in `data`.
 */
export function recordAuditLogSync(input: RecordAuditLogInput): AuditLogRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const resolved = resolveAuditLogWrite({
    ...input,
    workspaceId,
    createRandomId: () => `audit-${randomLikeId()}`,
  });
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO audit_log (id, workspace_id, title, note, code, data_json, source, source_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    resolved.id,
    resolved.workspaceId,
    resolved.title,
    resolved.note,
    resolved.code,
    resolved.dataJson,
    resolved.source,
    now,
  );
  const persisted = readAuditLogSync(resolved.id, resolved.workspaceId)!;
  assertAuditLogIdempotencyMatch(persisted, resolved);
  return persisted;
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

/**
 * Existence check for audit-log dedup: returns true when at least one audit row
 * matches `code` and every `jsonData` entry against the row's `data_json`
 * (`data_json->>key = value`). Used by legacy-migration reconciliation to avoid
 * re-recording a migration audit on every maintenance run. All lookups are
 * parameterized; never interpolates values into SQL.
 */
export function auditLogExistsForCodeSync(input: {
  workspaceId?: string;
  code: string;
  jsonData?: Record<string, string>;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const pairs = Object.entries(input.jsonData ?? {});
  let sql = "SELECT 1 FROM audit_log WHERE workspace_id = ? AND code = ?";
  const params: unknown[] = [workspaceId, input.code];
  for (const [key, value] of pairs) {
    sql += " AND data_json->>? = ?";
    params.push(key, value);
  }
  sql += " LIMIT 1";
  const row = getDatabase().prepare(sql).get(...params);
  return row !== undefined;
}

export function listAuditLogsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  options?: AuditLogListOptions,
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
  const jsonFilters: Array<[string, string | undefined]> = [
    ["runtimeId", options?.runtimeId],
    ["taskId", options?.taskId],
  ];
  for (const [key, value] of jsonFilters) {
    if (!value) continue;
    clauses.push(`data_json ->> '${key}' = ?`);
    params.push(value);
  }
  if (options?.actorId) {
    clauses.push("COALESCE(data_json ->> 'actorId', data_json ->> 'requestedByUserId', data_json ->> 'actorUserId') = ?");
    params.push(options.actorId);
  }
  if (options?.employeeId) {
    clauses.push("COALESCE(data_json ->> 'employeeId', data_json ->> 'agentId', data_json ->> 'employeeName') = ?");
    params.push(options.employeeId);
  }
  if (options?.sessionId) {
    clauses.push("COALESCE(data_json ->> 'sessionId', data_json ->> 'routerSessionId') = ?");
    params.push(options.sessionId);
  }
  if (options?.modelId) {
    clauses.push("COALESCE(data_json ->> 'modelId', data_json ->> 'model', data_json ->> 'defaultModel') = ?");
    params.push(options.modelId);
  }
  if (options?.createdFrom) {
    clauses.push("created_at >= ?");
    params.push(options.createdFrom);
  }
  if (options?.createdTo) {
    clauses.push("created_at <= ?");
    params.push(options.createdTo);
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
    dataJson: canonicalizeAuditLogDataJson(row.data_json),
    source: row.source,
    sourceIndex: row.source_index,
    createdAt: row.created_at,
  };
}
