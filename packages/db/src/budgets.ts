import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { BudgetAction, BudgetPeriod, BudgetRecord, BudgetScope } from "./types.ts";

export function upsertBudgetSync(input: {
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period?: BudgetPeriod;
  action?: BudgetAction;
  warningThreshold?: number;
  createdBy?: string;
  workspaceId?: string;
}): BudgetRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const period = input.period ?? "monthly";
  const action = input.action ?? "warn";
  const warningThreshold = input.warningThreshold ?? 0.8;
  const createdBy = input.createdBy ?? "";
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const scopeId = normalizeBudgetScopeId(input.scope, input.scopeId, workspaceId);

  const existing = db.prepare(
    "SELECT id FROM budget WHERE workspace_id = ? AND scope = ? AND scope_id = ?",
  ).get(workspaceId, input.scope, scopeId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE budget SET limit_usd = ?, period = ?, action = ?, warning_threshold = ?, updated_at = ?, created_by = ?
       WHERE id = ?`,
    ).run(input.limitUsd, period, action, warningThreshold, now, createdBy, existing.id);
    return readBudgetByIdSync(existing.id, workspaceId)!;
  }

  const id = randomLikeId();
  db.prepare(
    `INSERT INTO budget (id, workspace_id, scope, scope_id, limit_usd, period, action, warning_threshold, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, workspaceId, input.scope, scopeId, input.limitUsd, period, action, warningThreshold, createdBy, now, now);

  return readBudgetByIdSync(id, workspaceId)!;
}

export function readBudgetByIdSync(id: string, workspaceId?: string): BudgetRecord | undefined {
  const db = getDatabase();
  const row = (
    workspaceId
      ? db.prepare("SELECT * FROM budget WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
      : db.prepare("SELECT * FROM budget WHERE id = ?").get(id)
  ) as RawBudgetRow | undefined;
  return row ? mapBudgetRow(row) : undefined;
}

export function readBudgetSync(scope: BudgetScope, scopeId: string, workspaceId = DEFAULT_WORKSPACE_ID): BudgetRecord | undefined {
  const db = getDatabase();
  const normalizedScopeId = normalizeBudgetScopeId(scope, scopeId, workspaceId);
  const row = db.prepare(
    "SELECT * FROM budget WHERE workspace_id = ? AND scope = ? AND scope_id = ?",
  ).get(workspaceId, scope, normalizedScopeId) as RawBudgetRow | undefined;
  return row ? mapBudgetRow(row) : undefined;
}

export function listBudgetsSync(workspaceId = DEFAULT_WORKSPACE_ID): BudgetRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT * FROM budget WHERE workspace_id = ? ORDER BY scope, scope_id",
  ).all(workspaceId) as unknown as RawBudgetRow[];
  return rows.map(mapBudgetRow);
}

export function toggleBudgetSync(id: string, enabled: boolean, workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  db.prepare("UPDATE budget SET enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(
    enabled ? 1 : 0,
    new Date().toISOString(),
    id,
    workspaceId,
  );
}

export function deleteBudgetSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  db.prepare("DELETE FROM budget WHERE id = ? AND workspace_id = ?").run(id, workspaceId);
}

export function getSpentUsdSync(scope: BudgetScope, scopeId: string, since?: string, workspaceId = DEFAULT_WORKSPACE_ID): number {
  const db = getDatabase();
  let query: string;
  const params: string[] = [];

  if (scope === "workspace") {
    query = "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM token_usage WHERE workspace_id = ?";
    params.push(workspaceId);
    if (since) {
      query += " AND created_at >= ?";
      params.push(since);
    }
  } else if (scope === "agent") {
    query = "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM token_usage WHERE workspace_id = ? AND agent_id = ?";
    params.push(workspaceId);
    params.push(scopeId);
    if (since) {
      query += " AND created_at >= ?";
      params.push(since);
    }
  } else {
    query = "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM token_usage WHERE workspace_id = ? AND channel_name = ?";
    params.push(workspaceId);
    params.push(scopeId);
    if (since) {
      query += " AND created_at >= ?";
      params.push(since);
    }
  }

  const row = db.prepare(query).get(...params) as { spent: number };
  return row.spent;
}

export function getMonthStartIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

interface RawBudgetRow {
  id: string;
  workspace_id: string;
  scope: string;
  scope_id: string;
  limit_usd: number;
  period: string;
  action: string;
  warning_threshold: number;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function mapBudgetRow(row: RawBudgetRow): BudgetRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope as BudgetScope,
    scopeId: row.scope_id,
    limitUsd: row.limit_usd,
    period: row.period as BudgetPeriod,
    action: row.action as BudgetAction,
    warningThreshold: row.warning_threshold,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeBudgetScopeId(scope: BudgetScope, scopeId: string, workspaceId: string): string {
  if (scope === "workspace") {
    return workspaceId;
  }

  return scopeId;
}
