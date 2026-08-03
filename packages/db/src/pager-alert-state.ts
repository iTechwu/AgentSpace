import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { PagerAlertStateRecord } from "./types.ts";

const STATE_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, alert_key AS alertKey, code,
  employee_name AS employeeName, metric, severity, status,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
  occurrences, last_escalated_at AS lastEscalatedAt, cleared_at AS clearedAt`;

export interface UpsertPagerAlertStateInput {
  workspaceId?: string;
  alertKey: string;
  code: string;
  employeeName?: string;
  metric?: string;
  severity: string;
  now?: string;
}

/** Records a seen alert; increments occurrences when it is already active. */
export function upsertPagerAlertStateSync(input: UpsertPagerAlertStateInput): PagerAlertStateRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const existing = readPagerAlertStateByKeySync(input.alertKey, workspaceId);
  if (existing) {
    db.prepare(
      `UPDATE pager_alert_state
       SET severity = ?, status = 'active', last_seen_at = ?, occurrences = occurrences + 1, cleared_at = NULL
       WHERE id = ? AND workspace_id = ?`,
    ).run(input.severity, now, existing.id, workspaceId);
    return readPagerAlertStateSync(existing.id, workspaceId)!;
  }
  const id = `pa-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO pager_alert_state (
      id, workspace_id, alert_key, code, employee_name, metric, severity, status,
      first_seen_at, last_seen_at, occurrences, last_escalated_at, cleared_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, NULL, NULL)`,
  ).run(
    id,
    workspaceId,
    input.alertKey,
    input.code,
    input.employeeName?.trim() || null,
    input.metric?.trim() || null,
    input.severity,
    now,
    now,
  );
  return readPagerAlertStateSync(id, workspaceId)!;
}

/** Marks an active state cleared (recovery notification was dispatched). */
export function markPagerAlertClearedSync(input: {
  workspaceId?: string;
  alertKey: string;
  now?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const result = db.prepare(
    `UPDATE pager_alert_state
     SET status = 'cleared', cleared_at = ?
     WHERE workspace_id = ? AND alert_key = ? AND status = 'active'`,
  ).run(now, workspaceId, input.alertKey);
  return result.changes > 0;
}

export function readPagerAlertStateSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): PagerAlertStateRecord | null {
  const row = getDatabase().prepare(
    `${STATE_COLUMNS} FROM pager_alert_state WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapPagerAlertStateRecord(row) : null;
}

export function readPagerAlertStateByKeySync(
  alertKey: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): PagerAlertStateRecord | null {
  const row = getDatabase().prepare(
    `${STATE_COLUMNS} FROM pager_alert_state WHERE workspace_id = ? AND alert_key = ?`,
  ).get(workspaceId, alertKey) as Record<string, unknown> | undefined;
  return row ? mapPagerAlertStateRecord(row) : null;
}

export function listActivePagerAlertStatesSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): PagerAlertStateRecord[] {
  const rows = getDatabase().prepare(
    `${STATE_COLUMNS} FROM pager_alert_state WHERE workspace_id = ? AND status = 'active' ORDER BY last_seen_at DESC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapPagerAlertStateRecord).filter((r): r is PagerAlertStateRecord => r !== null);
}

function mapPagerAlertStateRecord(value: Record<string, unknown>): PagerAlertStateRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.alertKey !== "string" ||
    typeof value.code !== "string" ||
    typeof value.severity !== "string" ||
    (value.status !== "active" && value.status !== "cleared") ||
    typeof value.firstSeenAt !== "string" ||
    typeof value.lastSeenAt !== "string" ||
    typeof value.occurrences !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    alertKey: value.alertKey,
    code: value.code,
    employeeName: typeof value.employeeName === "string" ? value.employeeName : undefined,
    metric: typeof value.metric === "string" ? value.metric : undefined,
    severity: value.severity,
    status: value.status,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    occurrences: value.occurrences,
    lastEscalatedAt: typeof value.lastEscalatedAt === "string" ? value.lastEscalatedAt : undefined,
    clearedAt: typeof value.clearedAt === "string" ? value.clearedAt : undefined,
  };
}
