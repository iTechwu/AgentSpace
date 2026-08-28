import { randomUUID } from "node:crypto";
import { getDatabase } from "./database.ts";

export type TokenUsageBillingEventType =
  | "usage_recorded"
  | "usage_discovered"
  | "usage_attributed"
  | "billing_state_changed"
  | "usage_persistence_deferred"
  | "migration_snapshot";

export interface TokenUsageBillingEventRecord {
  id: string;
  workspaceId: string;
  tokenUsageId?: string;
  eventType: TokenUsageBillingEventType;
  snapshot: Record<string, unknown> & {
    billingStatus?: string;
    actualCostUsd?: number;
  };
  createdAt: string;
}

export function appendTokenUsageBillingEventSync(input: {
  workspaceId: string;
  tokenUsageId?: string;
  eventType: TokenUsageBillingEventType;
  snapshot: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  const id = `billing-event-${randomUUID()}`;
  getDatabase().prepare(
    `INSERT INTO token_usage_billing_event (
       id, workspace_id, token_usage_id, event_type, snapshot_json, created_at
     ) VALUES (?, ?, ?, ?, ?::jsonb, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.tokenUsageId ?? null,
    input.eventType,
    JSON.stringify(input.snapshot),
    now,
  );
}

export function listTokenUsageBillingEventsSync(input: {
  workspaceId: string;
  tokenUsageId?: string;
  limit?: number;
}): TokenUsageBillingEventRecord[] {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  const rows = input.tokenUsageId
    ? getDatabase().prepare(
        `SELECT * FROM token_usage_billing_event
         WHERE workspace_id = ? AND token_usage_id = ?
         ORDER BY created_at, id
         LIMIT ?`,
      ).all(input.workspaceId, input.tokenUsageId, limit)
    : getDatabase().prepare(
        `SELECT * FROM token_usage_billing_event
         WHERE workspace_id = ?
         ORDER BY created_at, id
         LIMIT ?`,
      ).all(input.workspaceId, limit);
  return (rows as Array<Record<string, unknown>>).map(mapBillingEvent);
}

function mapBillingEvent(row: Record<string, unknown>): TokenUsageBillingEventRecord {
  const rawSnapshot = parseJsonObject(row.snapshot_json);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    tokenUsageId: typeof row.token_usage_id === "string" ? row.token_usage_id : undefined,
    eventType: row.event_type as TokenUsageBillingEventType,
    snapshot: {
      ...rawSnapshot,
      billingStatus: readString(rawSnapshot.billing_status) ?? readString(rawSnapshot.billingStatus),
      actualCostUsd: readNumber(rawSnapshot.actual_cost_usd) ?? readNumber(rawSnapshot.actualCostUsd),
    },
    createdAt: String(row.created_at),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
