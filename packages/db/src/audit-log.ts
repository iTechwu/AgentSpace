import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { toIsoString, toJsonString, toOptionalString } from "./prisma/runtime-mappers.ts";
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
  options?: {
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
  },
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
    dataJson: row.data_json,
    source: row.source,
    sourceIndex: row.source_index,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 async Prisma repository (Route B).
//
// Coexists with the *Sync functions above and returns the SAME `AuditLogRecord`
// DTO. Callers migrate to these one async boundary at a time; *Sync is retained
// until no caller depends on it (Phase 4 removal).
//
// FIDELITY READS USE `$queryRawUnsafe` WITH `::text` CASTS. @prisma/adapter-pg
// mangles timestamptz (offset-relabel) and jsonb (object≠spaced text) relative
// to the legacy sync worker, so byte-parity is achieved by selecting
// `created_at::text` / `data_json::text` and mapping with the same logic the
// sync worker uses (`new Date(text).toISOString()` for ts; identity for jsonb).
// See prisma/runtime-mappers.ts for the full rationale. Identifiers are a
// hardcoded whitelist; only values are parameterized (`$1..$N`).
//
// `listAuditLogsAsync` keeps the legacy jsonb-extraction filters (`data_json ->>`
// + COALESCE) — they are not expressible in Prisma's structured `where`
// (README §4 rule 4). The `->>` predicate reads the jsonb column directly; only
// the OUTPUT row casts `data_json::text` for fidelity.
// ---------------------------------------------------------------------------

/**
 * Row shape produced by the fidelity read queries. `created_at` and
 * `data_json` arrive as the raw `::text` cast (not Prisma's Date/object) so the
 * mapper reproduces the sync worker's output exactly.
 */
type PrismaAuditLogRow = {
  id: string;
  workspace_id: string;
  title: string;
  note: string;
  code: string | null;
  data_json: string;
  source: string;
  source_index: number;
  created_at: string;
};

/** Shared column list with the fidelity casts on the timestamp/json columns. */
const AUDIT_LOG_SELECT_COLUMNS =
  "id, workspace_id, title, note, code, data_json::text AS data_json, source, source_index, created_at::text AS created_at";

export async function readAuditLogAsync(
  id: string,
  workspaceId?: string,
): Promise<AuditLogRecord | null> {
  const sql = workspaceId
    ? `SELECT ${AUDIT_LOG_SELECT_COLUMNS} FROM audit_log WHERE id = $1 AND workspace_id = $2`
    : `SELECT ${AUDIT_LOG_SELECT_COLUMNS} FROM audit_log WHERE id = $1`;
  const params = workspaceId ? [id, workspaceId] : [id];
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaAuditLogRow[]>(sql, ...params);
  return rows.length > 0 ? mapAuditLogFromPrisma(rows[0]!) : null;
}

export async function recordAuditLogAsync(
  input: RecordAuditLogInput,
): Promise<AuditLogRecord> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `audit-${randomLikeId()}`;
  const now = new Date().toISOString();
  const dataJson = JSON.stringify(input.data ?? {});
  // Raw INSERT: created_at is timestamptz. Typed Prisma `new Date()` is
  // serialized by @prisma/adapter-pg to an offset-less ISO, which PG parses in
  // the session timezone (+08) and shifts by −8h; writing the ISO string
  // mirrors the sync INSERT exactly. data_json also stays as a string (matches
  // the sync JSON.stringify) for fidelity.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO audit_log (id, workspace_id, title, note, code, data_json, source, source_index, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    id,
    workspaceId,
    input.title,
    input.note,
    input.code ?? null,
    dataJson,
    input.source ?? "runtime_lifecycle",
    now,
  );
  // Re-read via the fidelity text-cast path (mirrors recordAuditLogSync, which
  // INSERTs then readAuditLogSync). This returns the canonical PG jsonb text /
  // normalized timestamp rather than the adapter's Date/object shapes.
  const record = await readAuditLogAsync(id, workspaceId);
  if (!record) {
    throw new Error(`recordAuditLogAsync: audit_log row ${id} missing immediately after create`);
  }
  return record;
}

export async function listAuditLogsAsync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  options?: {
    source?: AuditLogSource;
    code?: string;
    actorId?: string;
    employeeId?: string;
    runtimeId?: string;
    taskId?: string;
    sessionId?: string;
    modelId?: string;
    createdFrom?: string;
    createdTo?: string;
    limit?: number;
  },
): Promise<AuditLogRecord[]> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const clauses = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let next = 2;
  const push = (clause: string, value: unknown): void => {
    clauses.push(clause.replace("$N", `$${next}`));
    params.push(value);
    next += 1;
  };
  if (options?.source) push("source = $N", options.source);
  if (options?.code) push("code = $N", options.code);
  if (options?.runtimeId) push("data_json ->> 'runtimeId' = $N", options.runtimeId);
  if (options?.taskId) push("data_json ->> 'taskId' = $N", options.taskId);
  if (options?.actorId) {
    push(
      "COALESCE(data_json ->> 'actorId', data_json ->> 'requestedByUserId', data_json ->> 'actorUserId') = $N",
      options.actorId,
    );
  }
  if (options?.employeeId) {
    push(
      "COALESCE(data_json ->> 'employeeId', data_json ->> 'agentId', data_json ->> 'employeeName') = $N",
      options.employeeId,
    );
  }
  if (options?.sessionId) {
    push(
      "COALESCE(data_json ->> 'sessionId', data_json ->> 'routerSessionId') = $N",
      options.sessionId,
    );
  }
  if (options?.modelId) {
    push(
      "COALESCE(data_json ->> 'modelId', data_json ->> 'model', data_json ->> 'defaultModel') = $N",
      options.modelId,
    );
  }
  if (options?.createdFrom) push("created_at >= $N", options.createdFrom);
  if (options?.createdTo) push("created_at <= $N", options.createdTo);
  const limitParam = `$${next}`;
  params.push(limit);

  const sql =
    `SELECT ${AUDIT_LOG_SELECT_COLUMNS} FROM audit_log ` +
    `WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limitParam}`;
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaAuditLogRow[]>(sql, ...params);
  return rows.map(mapAuditLogFromPrisma);
}

function mapAuditLogFromPrisma(row: PrismaAuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    note: row.note,
    code: toOptionalString(row.code),
    dataJson: toJsonString(row.data_json),
    source: row.source as AuditLogSource,
    sourceIndex: row.source_index,
    createdAt: toIsoString(row.created_at) ?? "",
  };
}
