import { randomUUID } from "node:crypto";
import { getDatabase } from "./database.ts";

export type RuntimeMaintenanceRunStatus = "running" | "succeeded" | "partial_failure";

export interface RuntimeMaintenanceRunRecord {
  id: string;
  status: RuntimeMaintenanceRunStatus;
  stages: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
}

export function createRuntimeMaintenanceRunSync(): RuntimeMaintenanceRunRecord {
  const id = `runtime-maintenance-${randomUUID()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_maintenance_run (id, status, stages_json, started_at, created_at)
     VALUES (?, 'running', '{}'::jsonb, ?, ?)`,
  ).run(id, now, now);
  return { id, status: "running", stages: {}, startedAt: now };
}

export function completeRuntimeMaintenanceRunSync(input: {
  id: string;
  status: Exclude<RuntimeMaintenanceRunStatus, "running">;
  stages: Record<string, unknown>;
}): RuntimeMaintenanceRunRecord | null {
  const finishedAt = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE runtime_maintenance_run
     SET status = ?, stages_json = ?::jsonb, finished_at = ?
     WHERE id = ?`,
  ).run(input.status, JSON.stringify(input.stages), finishedAt, input.id);
  return readRuntimeMaintenanceRunSync(input.id);
}

export function readRuntimeMaintenanceRunSync(id: string): RuntimeMaintenanceRunRecord | null {
  const row = getDatabase().prepare(
    "SELECT * FROM runtime_maintenance_run WHERE id = ?",
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status as RuntimeMaintenanceRunStatus,
    stages: parseJsonObject(row.stages_json),
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : undefined,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
