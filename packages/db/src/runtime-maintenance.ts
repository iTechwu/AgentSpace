import { randomUUID } from "node:crypto";
import { getDatabase, withTransaction } from "./database.ts";

export type RuntimeMaintenanceRunStatus = "running" | "succeeded" | "partial_failure";

export interface RuntimeMaintenanceRunRecord {
  id: string;
  status: RuntimeMaintenanceRunStatus;
  stages: Record<string, unknown>;
  startedAt: string;
  leaseExpiresAt: string;
  finishedAt?: string;
}

const MAINTENANCE_LEASE_MS = 5 * 60 * 1_000;

export function createRuntimeMaintenanceRunSync(): RuntimeMaintenanceRunRecord {
  const id = `runtime-maintenance-${randomUUID()}`;
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + MAINTENANCE_LEASE_MS).toISOString();
  const db = getDatabase();
  withTransaction(db, () => {
    const lock = db.prepare("SELECT pg_try_advisory_xact_lock(723041) AS acquired").get() as {
      acquired?: boolean;
    } | undefined;
    if (!lock?.acquired) throw new Error("runtime_maintenance.already_running");
    db.prepare(
      `UPDATE runtime_maintenance_run
       SET status = 'partial_failure',
           stages_json = jsonb_build_object('evidence', jsonb_build_object('status', 'failed', 'error', 'maintenance lease expired')),
           finished_at = ?
       WHERE status = 'running' AND lease_expires_at <= ?`,
    ).run(now, now);
    const active = db.prepare(
      "SELECT id FROM runtime_maintenance_run WHERE status = 'running' LIMIT 1",
    ).get();
    if (active) throw new Error("runtime_maintenance.already_running");
    db.prepare(
      `INSERT INTO runtime_maintenance_run (
         id, status, stages_json, started_at, lease_expires_at, created_at
       ) VALUES (?, 'running', '{}'::jsonb, ?, ?, ?)`,
    ).run(id, now, leaseExpiresAt, now);
  });
  return { id, status: "running", stages: {}, startedAt: now, leaseExpiresAt };
}

export function heartbeatRuntimeMaintenanceRunSync(id: string): void {
  const leaseExpiresAt = new Date(Date.now() + MAINTENANCE_LEASE_MS).toISOString();
  const result = getDatabase().prepare(
    `UPDATE runtime_maintenance_run
     SET lease_expires_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(leaseExpiresAt, id);
  if (result.changes !== 1) throw new Error("runtime_maintenance.lease_lost");
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
    leaseExpiresAt: String(row.lease_expires_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : undefined,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
