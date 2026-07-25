import type { TaskRecord } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";

export function listStoredTasksSync(workspaceId = DEFAULT_WORKSPACE_ID): TaskRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      id,
      title,
      channel_name AS channelName,
      assignee,
      priority,
      status,
      sort_order AS sortOrder,
      labels_json AS labelsJson
     FROM workspace_task
     WHERE workspace_id = ?
     ORDER BY COALESCE(sort_order, 0) ASC, updated_at DESC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map(mapStoredTaskRecord)
    .filter((task): task is TaskRecord => task !== null);
}

export function readStoredTaskSync(taskId: string, workspaceId = DEFAULT_WORKSPACE_ID): TaskRecord | null {
  return listStoredTasksSync(workspaceId).find((task) => task.id === taskId) ?? null;
}

export function createStoredTaskSync(task: TaskRecord, workspaceId = DEFAULT_WORKSPACE_ID): TaskRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_task (
      id,
      workspace_id,
      title,
      channel_name,
      assignee,
      priority,
      status,
      sort_order,
      labels_json,
      version,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    task.id,
    workspaceId,
    task.title,
    task.channel,
    task.assignee,
    task.priority,
    task.status,
    task.sortOrder ?? null,
    JSON.stringify(task.labels ?? []),
    now,
    now,
  );

  return readStoredTaskSync(task.id, workspaceId) ?? task;
}

export function updateStoredTaskSync(taskId: string, next: TaskRecord, workspaceId = DEFAULT_WORKSPACE_ID): TaskRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE workspace_task
     SET title = ?,
         channel_name = ?,
         assignee = ?,
         priority = ?,
         status = ?,
         sort_order = ?,
         labels_json = ?,
         version = version + 1,
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    next.title,
    next.channel,
    next.assignee,
    next.priority,
    next.status,
    next.sortOrder ?? null,
    JSON.stringify(next.labels ?? []),
    now,
    workspaceId,
    taskId,
  );
  if (result.changes === 0) {
    return null;
  }

  return readStoredTaskSync(taskId, workspaceId);
}

export function deleteStoredTaskSync(taskId: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM workspace_task
     WHERE workspace_id = ? AND id = ?`,
  ).run(workspaceId, taskId);
  return result.changes > 0;
}

export function deleteStoredTasksForChannelSync(channelName: string, workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  db.prepare(
    `DELETE FROM workspace_task
     WHERE workspace_id = ? AND channel_name = ?`,
  ).run(workspaceId, channelName);
}

export function deleteStoredTasksForAssigneeSync(employeeName: string, workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  db.prepare(
    `DELETE FROM workspace_task
     WHERE workspace_id = ? AND assignee = ?`,
  ).run(workspaceId, employeeName);
}

export function renameStoredTasksChannelSync(channelName: string, nextName: string, workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_task
     SET channel_name = ?,
         version = version + 1,
         updated_at = ?
     WHERE workspace_id = ? AND channel_name = ?`,
  ).run(nextName, now, workspaceId, channelName);
}

export function replaceStoredTasksSync(tasks: TaskRecord[], workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  withTransaction(db, () => {
    db.prepare("DELETE FROM workspace_task WHERE workspace_id = ?").run(workspaceId);
    for (const task of tasks) {
      createStoredTaskSync(task, workspaceId);
    }
  });
}

function mapStoredTaskRecord(row: Record<string, unknown>): TaskRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.channelName !== "string" ||
    typeof row.assignee !== "string" ||
    (row.priority !== "low" && row.priority !== "medium" && row.priority !== "high") ||
    (row.status !== "todo" && row.status !== "in_progress" && row.status !== "blocked" && row.status !== "done")
  ) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    channel: row.channelName,
    assignee: row.assignee,
    priority: row.priority,
    status: row.status,
    sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : undefined,
    labels: parseStringArray(typeof row.labelsJson === "string" ? row.labelsJson : "[]"),
  };
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
