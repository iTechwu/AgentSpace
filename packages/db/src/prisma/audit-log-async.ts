// audit-log Phase 2 异步 primary（pg.Client 直连原型）：
// - 当前 production 路径仍是 sync `recordAuditLogSync` / `readAuditLogSync`，
//   通过 worker_thread 内单连接 sqlite-bridge 走 pg（见 `database.ts`）。
// - 本模块提供 audit_log 表的异步 PG 直读，是 read-cutover 影子对比的
//   async primary 来源；影子 off 时完全无开销（不在 sync 路径上调用）。
//
// 说明：本文件使用 `pg.Client.query` 而不是 Prisma Client，原因：
// - Prisma Client 尚未在 db 包完成 P0 接入（依赖生成与运行时配置）；
// - Phase 2 验证目标 = cutover 协议（flag / 影子对比 / 主读 fallback），
//   不耦合具体 ORM。Prisma 接入后只需把 `readAuditLogAsync` 内部换成
//   `prisma.auditLog.findUnique`，对外契约不变。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { AuditLogRecord, AuditLogSource } from "../types.ts";

export interface AsyncAuditLogRecord {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code: string | null;
  dataJson: string;
  source: AuditLogSource;
  sourceIndex: number;
  createdAt: string;
}

export async function readAuditLogAsync(input: {
  id: string;
  workspaceId?: string;
}): Promise<AsyncAuditLogRecord | null> {
  const workspaceClause = input.workspaceId
    ? "AND workspace_id = $2"
    : "";
  const params: unknown[] = input.workspaceId
    ? [input.id, input.workspaceId]
    : [input.id];
  const sql = `SELECT id, workspace_id, title, note, code, data_json, source, source_index, created_at
               FROM audit_log WHERE id = $1 ${workspaceClause} LIMIT 1`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Whether async read path is enabled for cutover. Default = false so the
 * default run keeps the legacy sync read path with no overhead; CI / staging
 * flip on via env to exercise the cutover.
 */
export function isAuditLogAsyncReadEnabled(): boolean {
  return process.env.AUDIT_LOG_ASYNC_READ_ENABLED === "1";
}

/**
 * Whether shadow compare is enabled (legacy sync read runs alongside async
 * primary for drift detection). Shadow requires async primary to be enabled.
 */
export function isAuditLogShadowReadEnabled(): boolean {
  return process.env.AUDIT_LOG_SHADOW_READ_ENABLED === "1";
}

type RawRow = {
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

function mapRow(row: RawRow): AsyncAuditLogRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    note: row.note,
    code: row.code,
    dataJson: row.data_json,
    source: row.source,
    sourceIndex: row.source_index,
    createdAt: row.created_at,
  };
}

export function asyncToAuditLogRecord(record: AsyncAuditLogRecord): AuditLogRecord {
  // The pg driver auto-parses two columns to native types; the legacy sqlite
  // path stores them as raw strings. Normalize both so downstream callers and
  // the cutover compare see the same shape:
  // - data_json: JSONB → object; re-serialize to a stable JSON string.
  //   Whitespace between tokens differs from sqlite's `JSON.stringify`, so we
  //   re-parse + re-serialize via `JSON.stringify(JSON.parse(...))` to drop
  //   formatting differences.
  // - created_at: timestamp → Date object; convert back to ISO string.
  let dataJson: string;
  if (typeof record.dataJson === "string") {
    try {
      dataJson = JSON.stringify(JSON.parse(record.dataJson));
    } catch {
      dataJson = record.dataJson;
    }
  } else if (record.dataJson === null || record.dataJson === undefined) {
    dataJson = "{}";
  } else {
    try {
      dataJson = JSON.stringify(record.dataJson);
    } catch {
      dataJson = "{}";
    }
  }
  const createdAt = record.createdAt instanceof Date
    ? record.createdAt.toISOString()
    : record.createdAt;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    note: record.note,
    code: record.code ?? undefined,
    dataJson,
    source: record.source,
    sourceIndex: record.sourceIndex,
    createdAt,
  };
}