// Runtime 任务容量（docs/0820/session-split §5 + feature flag RUNTIME_TASK_CAPACITY_ENABLED）。
// 显式资源容量是「资源约束」而非「会话逻辑排队」：容量满时 task 保持 queued，投影为 capacity_wait。

import { getDatabase } from "./database.ts";
import { readConversationFeatureFlags } from "./conversation-flags.ts";

export interface RuntimeTaskCapacityRecord {
  runtimeId: string;
  maxConcurrentTasks: number;
  maxConcurrentTasksPerProvider?: Record<string, number>;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export function readRuntimeTaskCapacitySync(runtimeId: string): RuntimeTaskCapacityRecord | null {
  const row = getDatabase().prepare(
    "SELECT runtime_id AS \"runtimeId\", max_concurrent_tasks AS \"maxConcurrentTasks\", max_concurrent_tasks_per_provider_json AS \"maxConcurrentTasksPerProviderJson\", source, created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM runtime_task_capacity WHERE runtime_id = ?",
  ).get(runtimeId) as Record<string, unknown> | undefined;
  if (!row || typeof row.runtimeId !== "string" || typeof row.maxConcurrentTasks !== "number") {
    return null;
  }
  const perProvider = parseJsonRecord(row.maxConcurrentTasksPerProviderJson);
  return {
    runtimeId: row.runtimeId,
    maxConcurrentTasks: row.maxConcurrentTasks,
    maxConcurrentTasksPerProvider: perProvider,
    source: typeof row.source === "string" ? row.source : "default",
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

export function upsertRuntimeTaskCapacitySync(input: {
  runtimeId: string;
  maxConcurrentTasks: number;
  maxConcurrentTasksPerProvider?: Record<string, number>;
  source?: string;
}): RuntimeTaskCapacityRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runtime_task_capacity (runtime_id, max_concurrent_tasks, max_concurrent_tasks_per_provider_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (runtime_id) DO UPDATE SET max_concurrent_tasks = excluded.max_concurrent_tasks, max_concurrent_tasks_per_provider_json = excluded.max_concurrent_tasks_per_provider_json, source = excluded.source, updated_at = excluded.updated_at",
  ).run(
    input.runtimeId,
    Math.max(1, Math.floor(input.maxConcurrentTasks)),
    JSON.stringify(input.maxConcurrentTasksPerProvider ?? {}),
    input.source ?? "admin",
    now,
    now,
  );
  const record = readRuntimeTaskCapacitySync(input.runtimeId);
  if (!record) {
    throw new Error("Runtime task capacity could not be read after write.");
  }
  return record;
}

export function countActiveTasksForRuntimeSync(runtimeId: string): number {
  const row = getDatabase().prepare(
    "SELECT COUNT(*)::int AS count FROM agent_task_queue WHERE runtime_id = ? AND status IN ('claimed', 'running', 'preparing_commit')",
  ).get(runtimeId) as { count?: number } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export function isRuntimeAtCapacitySync(runtimeId: string): boolean {
  if (!readConversationFeatureFlags().runtimeTaskCapacityEnabled) {
    return false;
  }
  const capacity = readRuntimeTaskCapacitySync(runtimeId);
  if (!capacity || capacity.maxConcurrentTasks <= 0) {
    return false;
  }
  return countActiveTasksForRuntimeSync(runtimeId) >= capacity.maxConcurrentTasks;
}

function parseJsonRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record: Record<string, number> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === "number" && Number.isFinite(item)) {
        record[key] = item;
      }
    }
    return Object.keys(record).length > 0 ? record : undefined;
  } catch {
    return undefined;
  }
}
