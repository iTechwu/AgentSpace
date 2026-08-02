import { getDatabase, randomLikeId } from "./database.ts";
import type { TaskMessageRecord } from "./types.ts";
import { readQueuedTaskSync } from "./task-queue.ts";
import { buildTaskExecutionEventContext, recordTaskExecutionEventSync } from "./task-execution-events.ts";

export function appendTaskMessageSync(input: {
  taskId: string;
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
  refId?: string;
}): TaskMessageRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const currentSeqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM task_message WHERE task_id = ?")
    .get(input.taskId) as Record<string, unknown> | undefined;
  const seq = typeof currentSeqRow?.seq === "number" ? currentSeqRow.seq + 1 : 1;
  const messageId = `task-msg-${randomLikeId()}`;

  db.prepare(
    `INSERT INTO task_message (
      id,
      task_id,
      seq,
      type,
      tool,
      content,
      input_json,
      output,
      ref_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    input.taskId,
    seq,
    input.type,
    input.tool ?? null,
    input.content ?? null,
    input.inputJson ? JSON.stringify(input.inputJson) : null,
    input.output ?? null,
    input.refId ?? null,
    now,
  );

  const row = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        seq,
        type,
        tool,
        content,
        input_json AS inputJson,
        output,
        ref_id AS refId,
        created_at AS createdAt
      FROM task_message
      WHERE id = ?`,
    )
    .get(messageId) as Record<string, unknown>;

  const mapped = mapTaskMessageRecord(row);
  if (!mapped) {
    throw new Error(`Task message "${messageId}" could not be read back.`);
  }
  recordTaskMessageExecutionEvent(mapped);
  return mapped;
}

export function listTaskMessagesForTaskSync(taskId: string): TaskMessageRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        seq,
        type,
        tool,
        content,
        input_json AS inputJson,
        output,
        ref_id AS refId,
        created_at AS createdAt
      FROM task_message
      WHERE task_id = ?
      ORDER BY seq ASC`,
    )
    .all(taskId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapTaskMessageRecord(row))
    .filter((row): row is TaskMessageRecord => row !== null);
}

export function listTaskMessagesForTasksSync(taskIds: string[]): Map<string, TaskMessageRecord[]> {
  const grouped = new Map<string, TaskMessageRecord[]>();
  const uniqueTaskIds = [...new Set(taskIds)].filter((taskId) => typeof taskId === "string" && taskId.length > 0);
  if (uniqueTaskIds.length === 0) {
    return grouped;
  }

  const db = getDatabase();
  const placeholders = uniqueTaskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        seq,
        type,
        tool,
        content,
        input_json AS inputJson,
        output,
        ref_id AS refId,
        created_at AS createdAt
      FROM task_message
      WHERE task_id IN (${placeholders})
      ORDER BY task_id ASC, seq ASC`,
    )
    .all(...uniqueTaskIds) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const mapped = mapTaskMessageRecord(row);
    if (!mapped) {
      continue;
    }
    const messages = grouped.get(mapped.taskId) ?? [];
    messages.push(mapped);
    grouped.set(mapped.taskId, messages);
  }
  return grouped;
}

function mapTaskMessageRecord(value: Record<string, unknown>): TaskMessageRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.seq !== "number" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    taskId: value.taskId,
    seq: value.seq,
    type: value.type,
    tool: typeof value.tool === "string" ? value.tool : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    inputJson: typeof value.inputJson === "string" ? value.inputJson : undefined,
    output: typeof value.output === "string" ? value.output : undefined,
    refId: typeof value.refId === "string" ? value.refId : undefined,
    createdAt: value.createdAt,
  };
}

function recordTaskMessageExecutionEvent(message: TaskMessageRecord): void {
  const task = readQueuedTaskSync(message.taskId);
  if (!task) {
    return;
  }
  const event = deriveTaskMessageExecutionEvent(message);
  if (!event) {
    return;
  }
  const context = buildTaskExecutionEventContext(task);
  recordTaskExecutionEventSync({
    ...context,
    ...event,
    data: {
      triggerType: context.triggerType,
      issueId: context.issueId,
      taskTitle: context.taskTitle,
      taskMessageId: message.id,
      taskMessageSeq: message.seq,
      messageType: message.type,
      tool: message.tool,
    },
  });
}

function deriveTaskMessageExecutionEvent(message: TaskMessageRecord): Omit<Parameters<typeof recordTaskExecutionEventSync>[0], "workspaceId" | "taskId" | "channelName" | "agentId" | "runtimeId" | "runId" | "data"> | null {
  const tool = message.tool ?? "tool";
  if (message.type === "tool_use") {
    return {
      type: "tool_started",
      title: `${tool} started`,
      summary: truncateUserFacingSummary(message.content),
      status: "running",
    };
  }
  if (message.type === "tool_result") {
    return {
      type: "tool_finished",
      title: `${tool} finished`,
      summary: truncateUserFacingSummary(message.content ?? message.output),
      status: "succeeded",
    };
  }
  if (message.type === "error") {
    return {
      type: "blocked",
      title: "Runtime reported an error",
      summary: truncateUserFacingSummary(message.content ?? message.output),
      severity: "error",
      status: "failed",
    };
  }
  if (message.type === "text") {
    return {
      type: "message_posted",
      title: "Agent response captured",
      summary: truncateUserFacingSummary(message.content ?? message.output),
      status: "succeeded",
    };
  }
  if (message.type === "status" && /^Task started on\b/i.test(message.content ?? "")) {
    return {
      type: "context_loaded",
      title: "Provider context loaded",
      summary: truncateUserFacingSummary(message.content),
      status: "running",
    };
  }
  return null;
}

function truncateUserFacingSummary(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
