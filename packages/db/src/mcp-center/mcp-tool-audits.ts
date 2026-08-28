// mcp-tool-audits 域：工具调用审计写入 / 查询 / 截断清理。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "../database.ts";
import { recordAuditLogSync } from "../audit-log.ts";
import type {
  McpToolCallOutcome,
  RuntimeMcpToolAuditRecord,
} from "../types.ts";
import {
  MCP_TOOL_AUDIT_COLUMNS,
  mapRuntimeMcpToolAuditRecord,
  throwMissing,
} from "./mcp-center-internal.ts";

export interface RecordMcpToolAuditInput {
  workspaceId?: string;
  connectionId: string;
  taskId?: string;
  toolName: string;
  outcome: McpToolCallOutcome;
  latencyMs?: number;
  safeSummary?: string;
  /** Client-generated idempotency key; a replayed event_id returns the original row. */
  eventId?: string;
  /** Execution identity must come from the authenticated task, never the report body. */
  actorType: "agent";
  actorId: string;
  runtimeId: string;
}

export function recordMcpToolAuditSync(input: RecordMcpToolAuditInput): RuntimeMcpToolAuditRecord {
  return withTransaction(getDatabase(), () => {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const eventId = input.eventId?.trim() || "";
    if (!input.actorId.trim() || !input.runtimeId.trim()) {
      throw new Error("MCP tool audit actorId and runtimeId are required.");
    }
    if (eventId) {
      const existing = getDatabase().prepare(
        `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE workspace_id = ? AND event_id = ?`,
      ).get(workspaceId, eventId) as Record<string, unknown> | undefined;
      if (existing) {
        const record = mapRuntimeMcpToolAuditRecord(existing);
        if (record) return record;
      }
    }
    const id = `mcp-audit-${randomLikeId()}`;
    const now = new Date().toISOString();
    const inserted = getDatabase().prepare(
      `INSERT INTO runtime_mcp_tool_audit (id, workspace_id, connection_id, task_id, tool_name, outcome, latency_ms, safe_summary, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, event_id) DO NOTHING`,
    ).run(
      id,
      workspaceId,
      input.connectionId,
      input.taskId ?? null,
      input.toolName,
      input.outcome,
      input.latencyMs ?? null,
      input.safeSummary ?? null,
      eventId || null,
      now,
    );
    if (inserted.changes > 0) {
      recordAuditLogSync({
        workspaceId,
        title: "MCP tool call",
        note: `${input.actorId} called ${input.toolName} through ${input.connectionId}.`,
        code: "mcp_tool.call",
        source: "runtime_lifecycle",
        data: {
          actorType: input.actorType,
          actorId: input.actorId,
          runtimeId: input.runtimeId,
          taskId: input.taskId,
          connectionId: input.connectionId,
          toolName: input.toolName,
          eventId: eventId || undefined,
          mcpToolAuditId: id,
        },
      });
    }
    const row = getDatabase().prepare(
      `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    let record = row ? mapRuntimeMcpToolAuditRecord(row) : null;
    if (!record && eventId) {
      // Concurrent conflict: another request won the race for this event_id and
      // our INSERT was a no-op. Read the winner's row back by (workspace, event).
      const winner = getDatabase().prepare(
        `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE workspace_id = ? AND event_id = ?`,
      ).get(workspaceId, eventId) as Record<string, unknown> | undefined;
      record = winner ? mapRuntimeMcpToolAuditRecord(winner) : null;
    }
    if (!record) {
      throwMissing("tool audit");
    }
    return record;
  });
}

export function listMcpToolAuditsSync(options: {
  workspaceId?: string;
  connectionId?: string;
  taskId?: string;
  limit?: number;
} = {}): RuntimeMcpToolAuditRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.connectionId) {
    where.push("connection_id = ?");
    params.push(options.connectionId);
  }
  if (options.taskId) {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = getDatabase().prepare(
    `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpToolAuditRecord).filter((r): r is RuntimeMcpToolAuditRecord => r !== null);
}

export function deleteMcpToolAuditsBeforeSync(cutoff: string): number {
  return getDatabase().prepare(
    "DELETE FROM runtime_mcp_tool_audit WHERE created_at < ?",
  ).run(cutoff).changes;
}
