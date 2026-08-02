import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import {
  isTaskExecutionEventSeverity,
  isTaskExecutionEventStatus,
  isTaskExecutionEventType,
  type QueuedTaskRecord,
  type TaskExecutionEventRecord,
  type TaskExecutionEventSeverity,
  type TaskExecutionEventStatus,
  type TaskExecutionEventType,
} from "./types.ts";
import { readQueuedTaskSync } from "./task-queue.ts";
import { readLatestAgentTaskAttemptForTaskSync, recordAgentRouterEventSync } from "./agent-router-sessions.ts";

export interface TaskExecutionEventInput {
  workspaceId?: string;
  taskId: string;
  channelName?: string;
  agentId: string;
  runtimeId?: string;
  runId?: string;
  type: TaskExecutionEventType;
  title: string;
  summary?: string;
  severity?: TaskExecutionEventSeverity;
  status?: TaskExecutionEventStatus;
  data?: Record<string, unknown>;
  createdAt?: string;
}

export interface TaskExecutionEventListOptions {
  workspaceId?: string;
  taskId?: string;
  channelName?: string;
  agentId?: string;
  runtimeId?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export interface TaskExecutionEventContext {
  workspaceId: string;
  taskId: string;
  channelName: string;
  agentId: string;
  runtimeId: string;
  runId?: string;
  taskTitle?: string;
  issueId?: string;
  triggerType: string;
}

export function recordTaskExecutionEventSync(input: TaskExecutionEventInput): TaskExecutionEventRecord {
  const db = getDatabase();
  const eventId = `task-event-${randomLikeId()}`;
  const now = input.createdAt ?? new Date().toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const severity = input.severity ?? "info";
  const dataJson = JSON.stringify(input.data ?? {});

  db.prepare(
    `INSERT INTO task_execution_event (
      id,
      workspace_id,
      task_id,
      channel_name,
      agent_id,
      runtime_id,
      run_id,
      type,
      title,
      summary,
      severity,
      status,
      data_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    workspaceId,
    input.taskId,
    input.channelName ?? "",
    input.agentId,
    input.runtimeId ?? null,
    input.runId ?? null,
    input.type,
    input.title,
    input.summary ?? null,
    severity,
    input.status ?? null,
    dataJson,
    now,
  );

  const event = readTaskExecutionEventSync(eventId);
  if (!event) {
    throw new Error(`Task execution event "${eventId}" could not be read back.`);
  }
  projectTaskExecutionEventToRouterEvent(event);
  return event;
}

export function listTaskExecutionEventsSync(
  options: TaskExecutionEventListOptions = {},
): TaskExecutionEventRecord[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (typeof options.workspaceId === "string") {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (typeof options.taskId === "string") {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  if (typeof options.channelName === "string") {
    where.push("channel_name = ?");
    params.push(options.channelName);
  }
  if (typeof options.agentId === "string") {
    where.push("agent_id = ?");
    params.push(options.agentId);
  }
  if (typeof options.runtimeId === "string") {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }

  const limit = normalizeLimit(options.limit);
  const order = options.order === "desc" ? "DESC" : "ASC";
  const tieOrder = options.order === "desc" ? "DESC" : "ASC";
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      task_id AS taskId,
      channel_name AS channelName,
      agent_id AS agentId,
      runtime_id AS runtimeId,
      run_id AS runId,
      type,
      title,
      summary,
      severity,
      status,
      data_json AS dataJson,
      created_at AS createdAt
     FROM task_execution_event
     ${whereClause}
     ORDER BY created_at ${order}, id ${tieOrder}
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapTaskExecutionEventRecord(row))
    .filter((row): row is TaskExecutionEventRecord => row !== null);
}

export function buildTaskExecutionEventContext(task: QueuedTaskRecord): TaskExecutionEventContext {
  const payload = safeParseJsonObject(task.inputJson);
  const channelName = readFirstString(payload, ["channelName", "channel", "contactId"]) ?? "";
  return {
    workspaceId: task.workspaceId,
    taskId: task.id,
    channelName,
    agentId: task.employeeId,
    runtimeId: task.runtimeId,
    runId: task.sessionId,
    taskTitle: readFirstString(payload, ["title", "taskTitle"]),
    issueId: task.issueId,
    triggerType: task.triggerType,
  };
}

function readTaskExecutionEventSync(eventId: string): TaskExecutionEventRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      task_id AS taskId,
      channel_name AS channelName,
      agent_id AS agentId,
      runtime_id AS runtimeId,
      run_id AS runId,
      type,
      title,
      summary,
      severity,
      status,
      data_json AS dataJson,
      created_at AS createdAt
     FROM task_execution_event
     WHERE id = ?`,
  ).get(eventId) as Record<string, unknown> | undefined;

  return row ? mapTaskExecutionEventRecord(row) : null;
}

function mapTaskExecutionEventRecord(value: Record<string, unknown>): TaskExecutionEventRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.channelName !== "string" ||
    typeof value.agentId !== "string" ||
    !isTaskExecutionEventType(value.type) ||
    typeof value.title !== "string" ||
    !isTaskExecutionEventSeverity(value.severity) ||
    typeof value.dataJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  const status = isTaskExecutionEventStatus(value.status) ? value.status : undefined;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    taskId: value.taskId,
    channelName: value.channelName,
    agentId: value.agentId,
    runtimeId: typeof value.runtimeId === "string" ? value.runtimeId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    type: value.type,
    title: value.title,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    severity: value.severity,
    status,
    dataJson: value.dataJson,
    createdAt: value.createdAt,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function safeParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function projectTaskExecutionEventToRouterEvent(event: TaskExecutionEventRecord): void {
  const task = readQueuedTaskSync(event.taskId);
  if (!task?.routerSessionId) {
    return;
  }
  const attempt = readLatestAgentTaskAttemptForTaskSync(event.taskId);
  recordAgentRouterEventSync({
    workspaceId: event.workspaceId,
    routerSessionId: task.routerSessionId,
    taskQueueId: event.taskId,
    attemptId: attempt?.id,
    type: `task.${event.type}`,
    actorType: event.runtimeId ? "runtime" : "system",
    actorId: event.runtimeId ?? event.agentId,
    runtimeId: event.runtimeId,
    summary: event.summary ?? event.title,
    data: {
      taskExecutionEventId: event.id,
      title: event.title,
      severity: event.severity,
      status: event.status,
      channelName: event.channelName,
      runId: event.runId,
      ...safeParseJsonObject(event.dataJson),
    },
    createdAt: event.createdAt,
  });
}
