import { randomUUID } from "node:crypto";
import { getDatabase } from "./database.ts";
import { appendTokenUsageBillingEventSync } from "./token-usage-events.ts";
import type { RecordTokenUsageInput } from "./token-usage.ts";

export interface TokenUsageRetryRecord {
  id: string;
  payload: RecordTokenUsageInput;
  attempts: number;
}

export function enqueueTokenUsageRetrySync(input: RecordTokenUsageInput, error: unknown): void {
  if (!input.workspaceId || !input.taskQueueId) {
    throw new Error("token_usage_retry.workspace_and_task_required");
  }
  const db = getDatabase();
  const now = new Date().toISOString();
  const correlation = input.gatewayRequestId
    ?? input.gatewayUsageId
    ?? `${input.modelId}:${input.requestStartedAt ?? "unknown"}:${input.inputTokens}:${input.outputTokens}`;
  const idempotencyKey = `${input.taskQueueId}:${correlation}`;
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(
    `INSERT INTO token_usage_retry (
      id, workspace_id, task_queue_id, idempotency_key, payload_json,
      status, attempts, next_attempt_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?::jsonb, 'pending', 0, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET
       payload_json = EXCLUDED.payload_json,
       status = 'pending',
       next_attempt_at = EXCLUDED.next_attempt_at,
       last_error = EXCLUDED.last_error,
       updated_at = EXCLUDED.updated_at`,
  ).run(
    `token-usage-retry-${randomUUID()}`,
    input.workspaceId,
    input.taskQueueId,
    idempotencyKey,
    JSON.stringify(input),
    now,
    message.slice(0, 1_000),
    now,
    now,
  );
  try {
    appendTokenUsageBillingEventSync({
      workspaceId: input.workspaceId,
      eventType: "usage_persistence_deferred",
      snapshot: { ...input, persistenceError: message.slice(0, 1_000) },
    });
  } catch {
    // The durable retry is authoritative; event evidence must not invalidate it.
  }
}

export function listDueTokenUsageRetriesSync(limit = 100): TokenUsageRetryRecord[] {
  const rows = getDatabase().prepare(
    `SELECT id, payload_json, attempts
     FROM token_usage_retry
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(new Date().toISOString(), Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    payload: parseUsageRetryPayload(row.payload_json),
    attempts: Number(row.attempts) || 0,
  }));
}

export function claimDueTokenUsageRetriesSync(limit = 100): TokenUsageRetryRecord[] {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
  const rows = getDatabase().prepare(
    `WITH due AS (
       SELECT id
       FROM token_usage_retry
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     UPDATE token_usage_retry AS retry
     SET next_attempt_at = ?, updated_at = ?
     FROM due
     WHERE retry.id = due.id
     RETURNING retry.id, retry.payload_json, retry.attempts`,
  ).all(
    now.toISOString(),
    Math.min(Math.max(limit, 1), 500),
    leaseUntil,
    now.toISOString(),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    payload: parseUsageRetryPayload(row.payload_json),
    attempts: Number(row.attempts) || 0,
  }));
}

export function completeTokenUsageRetrySync(id: string): void {
  getDatabase().prepare("DELETE FROM token_usage_retry WHERE id = ?").run(id);
}

export function failTokenUsageRetrySync(id: string, attempts: number, error: unknown): void {
  const nextAttempts = attempts + 1;
  const delayMs = Math.min(60 * 60 * 1_000, 5_000 * (2 ** Math.min(nextAttempts, 8)));
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE token_usage_retry
     SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextAttempts, new Date(Date.now() + delayMs).toISOString(), message.slice(0, 1_000), now, id);
}

function parseUsageRetryPayload(value: unknown): RecordTokenUsageInput {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("token_usage_retry.invalid_payload");
  return parsed as RecordTokenUsageInput;
}
