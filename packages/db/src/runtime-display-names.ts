import { DEFAULT_WORKSPACE_ID, getDatabase } from "./database.ts";
import type { WorkspaceRuntimeDisplayNameRecord } from "./types.ts";

export function listWorkspaceRuntimeDisplayNamesSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceRuntimeDisplayNameRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      workspace_id AS "workspaceId",
      runtime_id AS "runtimeId",
      display_name AS "displayName",
      updated_by_user_id AS "updatedByUserId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM workspace_runtime_display_name
     WHERE workspace_id = ?
     ORDER BY created_at ASC, runtime_id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map(mapWorkspaceRuntimeDisplayNameRecord)
    .filter((record): record is WorkspaceRuntimeDisplayNameRecord => record !== null);
}

export function updateWorkspaceRuntimeDisplayNameSync(input: {
  workspaceId?: string;
  runtimeId: string;
  displayName: string;
  updatedByUserId?: string;
}): WorkspaceRuntimeDisplayNameRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
  const runtimeId = input.runtimeId.trim();
  const displayName = input.displayName.trim();
  const updatedByUserId = input.updatedByUserId?.trim() || null;

  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }
  if (displayName.length > 80) {
    throw new Error("runtime.display_name_too_long");
  }
  ensureRuntimeExists(workspaceId, runtimeId);

  if (!displayName) {
    db.prepare(
      `DELETE FROM workspace_runtime_display_name
       WHERE workspace_id = ? AND runtime_id = ?`,
    ).run(workspaceId, runtimeId);
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_runtime_display_name (
      workspace_id,
      runtime_id,
      display_name,
      updated_by_user_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, runtime_id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at`,
  ).run(workspaceId, runtimeId, displayName, updatedByUserId, now, now);

  return readWorkspaceRuntimeDisplayNameSync(workspaceId, runtimeId);
}

function readWorkspaceRuntimeDisplayNameSync(
  workspaceId: string,
  runtimeId: string,
): WorkspaceRuntimeDisplayNameRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      workspace_id AS "workspaceId",
      runtime_id AS "runtimeId",
      display_name AS "displayName",
      updated_by_user_id AS "updatedByUserId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM workspace_runtime_display_name
     WHERE workspace_id = ? AND runtime_id = ?`,
  ).get(workspaceId, runtimeId) as Record<string, unknown> | undefined;

  return row ? mapWorkspaceRuntimeDisplayNameRecord(row) : null;
}

function ensureRuntimeExists(workspaceId: string, runtimeId: string): void {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1
     FROM agent_runtime
     WHERE workspace_id = ? AND id = ?
     LIMIT 1`,
  ).get(workspaceId, runtimeId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Runtime "${runtimeId}" does not exist.`);
  }
}

function mapWorkspaceRuntimeDisplayNameRecord(
  value: Record<string, unknown>,
): WorkspaceRuntimeDisplayNameRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    displayName: value.displayName,
    updatedByUserId: typeof value.updatedByUserId === "string" ? value.updatedByUserId : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
