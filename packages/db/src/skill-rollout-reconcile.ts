import { getDatabase, randomLikeId, withTransaction, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { SkillRolloutReconcileItemRecord } from "./types.ts";

const COLUMNS = `
  id, workspace_id AS "workspaceId", plan_id AS "planId", runtime_id AS "runtimeId",
  artifact_digest AS "artifactDigest", status, installation_id AS "installationId",
  revision, error_code AS "errorCode", attempt_count AS "attemptCount",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface InitializeSkillRolloutReconcileItemsInput {
  workspaceId?: string;
  planId: string;
  items: Array<{ runtimeId: string; artifactDigest: string; status?: "pending" | "created"; installationId?: string; revision?: string }>;
}

export function initializeSkillRolloutReconcileItemsSync(input: InitializeSkillRolloutReconcileItemsInput): SkillRolloutReconcileItemRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const db = getDatabase();
  withTransaction(db, () => {
    const statement = db.prepare(
      `INSERT INTO skill_rollout_reconcile_item (
        id, workspace_id, plan_id, runtime_id, artifact_digest, status,
        installation_id, revision, error_code, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
      ON CONFLICT(plan_id, runtime_id, artifact_digest) DO NOTHING`,
    );
    for (const item of input.items) {
      statement.run(
        `sri-${randomLikeId()}`,
        workspaceId,
        input.planId,
        item.runtimeId,
        item.artifactDigest,
        item.status ?? "pending",
        item.installationId ?? null,
        item.revision ?? null,
        now,
        now,
      );
    }
  });
  return listSkillRolloutReconcileItemsSync(input.planId, workspaceId);
}

export function listSkillRolloutReconcileItemsSync(planId: string, workspaceId = DEFAULT_WORKSPACE_ID): SkillRolloutReconcileItemRecord[] {
  const rows = getDatabase().prepare(
    `SELECT ${COLUMNS} FROM skill_rollout_reconcile_item
     WHERE plan_id = ? AND workspace_id = ? ORDER BY runtime_id, artifact_digest`,
  ).all(planId, workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapRecord).filter((item): item is SkillRolloutReconcileItemRecord => item !== null);
}

export function markSkillRolloutReconcileItemSync(input: {
  id: string;
  workspaceId?: string;
  status: "created" | "failed";
  installationId?: string;
  revision?: string;
  errorCode?: string;
}): SkillRolloutReconcileItemRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE skill_rollout_reconcile_item
     SET status = ?, installation_id = COALESCE(?, installation_id),
         revision = COALESCE(?, revision), error_code = ?,
         attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status <> 'created'`,
  ).run(input.status, input.installationId ?? null, input.revision ?? null, input.errorCode ?? null, now, input.id, workspaceId);
  const row = getDatabase().prepare(
    `SELECT ${COLUMNS} FROM skill_rollout_reconcile_item WHERE id = ? AND workspace_id = ?`,
  ).get(input.id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRecord(row) : null;
}

function mapRecord(value: Record<string, unknown>): SkillRolloutReconcileItemRecord | null {
  if (typeof value.id !== "string" || typeof value.workspaceId !== "string" || typeof value.planId !== "string"
    || typeof value.runtimeId !== "string" || typeof value.artifactDigest !== "string"
    || (value.status !== "pending" && value.status !== "created" && value.status !== "failed")
    || typeof value.attemptCount !== "number" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    planId: value.planId,
    runtimeId: value.runtimeId,
    artifactDigest: value.artifactDigest,
    status: value.status,
    installationId: typeof value.installationId === "string" ? value.installationId : undefined,
    revision: typeof value.revision === "string" ? value.revision : undefined,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
    attemptCount: value.attemptCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
