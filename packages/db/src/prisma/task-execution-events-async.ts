// task-execution-events Phase 2 异步 primary（pg.Client 直连原型）：
// - listTaskExecutionEventsAsync 通过 pg.Client 直连 PG 拉 task_execution_event
//   行，作为 cutover runner 的 async primary。
// - shadow 关闭时无任何额外开销（不在 sync 路径上调用）。
// - mapTaskExecutionEventRow 桥接 pg JSONB → object 与 Date → ISO 的类型差异。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { TaskExecutionEventListOptions } from "../task-execution-events.ts";
import type { TaskExecutionEventRecord } from "../types.ts";

interface AsyncTaskEventRow {
  id: string;
  workspace_id: string | null;
  task_id: string | null;
  channel_name: string | null;
  agent_id: string | null;
  runtime_id: string | null;
  run_id: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  severity: string;
  status: string;
  data_json: unknown;
  created_at: Date | string;
}

const SEVERITIES = new Set(["info", "warning", "error", "success"]);
const STATUSES = new Set(["pending", "running", "succeeded", "failed"]);

export async function listTaskExecutionEventsAsync(
  options: TaskExecutionEventListOptions = {},
): Promise<TaskExecutionEventRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  function pushIfString(value: string | undefined, column: string): void {
    if (typeof value === "string") {
      conditions.push(`${column} = $${params.length + 1}`);
      params.push(value);
    }
  }
  pushIfString(options.workspaceId, "workspace_id");
  pushIfString(options.taskId, "task_id");
  pushIfString(options.channelName, "channel_name");
  pushIfString(options.agentId, "agent_id");
  pushIfString(options.runtimeId, "runtime_id");

  const limit = normalizeLimit(options.limit);
  const order = options.order === "desc" ? "DESC" : "ASC";
  const tieOrder = options.order === "desc" ? "DESC" : "ASC";
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const sql = `SELECT id, workspace_id, task_id, channel_name, agent_id,
                      runtime_id, run_id, type, title, summary,
                      severity, status, data_json, created_at
               FROM task_execution_event
               ${whereClause}
               ORDER BY created_at ${order}, id ${tieOrder}
               LIMIT $${params.length}`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<AsyncTaskEventRow>(sql, params);
    return result.rows
      .map(mapTaskExecutionEventRow)
      .filter((row): row is TaskExecutionEventRecord => row !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isTaskExecutionEventsAsyncReadEnabled(): boolean {
  return process.env.TASK_EXECUTION_EVENTS_ASYNC_READ_ENABLED === "1";
}

export function isTaskExecutionEventsShadowReadEnabled(): boolean {
  return process.env.TASK_EXECUTION_EVENTS_SHADOW_READ_ENABLED === "1";
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}

function mapTaskExecutionEventRow(
  row: AsyncTaskEventRow,
): TaskExecutionEventRecord | null {
  if (!SEVERITIES.has(row.severity)) return null;
  if (!STATUSES.has(row.status)) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? "",
    taskId: row.task_id ?? "",
    channelName: row.channel_name ?? "",
    agentId: row.agent_id ?? "",
    runtimeId: row.runtime_id ?? undefined,
    runId: row.run_id ?? undefined,
    type: row.type as TaskExecutionEventRecord["type"],
    title: row.title ?? "",
    summary: row.summary ?? undefined,
    severity: row.severity as TaskExecutionEventRecord["severity"],
    status: row.status as TaskExecutionEventRecord["status"],
    dataJson: serializeJson(row.data_json),
    createdAt: toIsoString(row.created_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}