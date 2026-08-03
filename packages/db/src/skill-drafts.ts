import { getDatabase, DEFAULT_WORKSPACE_ID } from "./database.ts";

export interface SkillDraftSnapshot {
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
}

export interface SkillDraftRecord {
  workspaceId: string;
  skillId: string;
  draftJson: string;
  updatedByUserId?: string;
  updatedAt: string;
}

export function upsertSkillDraftSync(input: {
  workspaceId?: string;
  skillId: string;
  draftJson: string;
  updatedByUserId?: string;
}): SkillDraftRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_draft (workspace_id, skill_id, draft_json, updated_by_user_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, skill_id) DO UPDATE SET
       draft_json = excluded.draft_json,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
  ).run(
    workspaceId,
    input.skillId,
    input.draftJson,
    input.updatedByUserId?.trim() || null,
    now,
  );
  return readSkillDraftSync(input.skillId, workspaceId)!;
}

export function readSkillDraftSync(
  skillId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillDraftRecord | null {
  const row = getDatabase().prepare(
    `SELECT workspace_id AS workspaceId, skill_id AS skillId,
            draft_json AS draftJson, updated_by_user_id AS updatedByUserId, updated_at AS updatedAt
     FROM skill_draft WHERE workspace_id = ? AND skill_id = ?`,
  ).get(workspaceId, skillId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    workspaceId: row.workspaceId as string,
    skillId: row.skillId as string,
    draftJson: row.draftJson as string,
    updatedByUserId: typeof row.updatedByUserId === "string" ? row.updatedByUserId : undefined,
    updatedAt: row.updatedAt as string,
  };
}

export function deleteSkillDraftSync(
  skillId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): boolean {
  const result = getDatabase().prepare(
    `DELETE FROM skill_draft WHERE workspace_id = ? AND skill_id = ?`,
  ).run(workspaceId, skillId);
  return result.changes > 0;
}

export function listSkillDraftSkillIdsSync(workspaceId = DEFAULT_WORKSPACE_ID): string[] {
  const rows = getDatabase().prepare(
    `SELECT skill_id AS skillId FROM skill_draft WHERE workspace_id = ? ORDER BY updated_at DESC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map((row) => row.skillId ?? row.skillid).filter((id): id is string => typeof id === "string");
}
