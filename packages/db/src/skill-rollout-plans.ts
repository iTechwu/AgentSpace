import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { SkillRolloutPlanRecord } from "./types.ts";

const PLAN_COLUMNS = `SELECT
  id, workspace_id AS "workspaceId", root_artifact_digest AS "rootArtifactDigest",
  plan_digest AS "planDigest", policy_version AS "policyVersion",
  closure_json AS "closureJson", target_runtimes_json AS "targetRuntimesJson",
  risk_summary_json AS "riskSummaryJson", decision,
  actor_user_id AS "actorUserId", created_at AS "createdAt", consumed_at AS "consumedAt"`;

export interface CreateSkillRolloutPlanInput {
  workspaceId?: string;
  rootArtifactDigest: string;
  planDigest: string;
  policyVersion?: string;
  closureJson: string;
  targetRuntimesJson: string;
  riskSummaryJson: string;
  decision?: "pending" | "approved" | "rejected";
  actorUserId?: string;
}

/**
 * Records a skill rollout plan: ONE approval bound to a dependency closure +
 * target runtime set + planDigest, so every child installation references it
 * instead of consuming a per-installation approval.
 *
 * Each call inserts a FRESH plan (mirroring skill_install_approval): the same
 * planDigest can be re-approved later for another rollout, because a consumed
 * plan is a one-shot instance keyed by its own id, not by the digest.
 */
export function createSkillRolloutPlanSync(input: CreateSkillRolloutPlanInput): SkillRolloutPlanRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `srp-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_rollout_plan (
      id, workspace_id, root_artifact_digest, plan_digest, policy_version,
      closure_json, target_runtimes_json, risk_summary_json, decision,
      actor_user_id, created_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    workspaceId,
    input.rootArtifactDigest.trim().toLowerCase(),
    input.planDigest.trim().toLowerCase(),
    input.policyVersion?.trim() || "v1",
    input.closureJson,
    input.targetRuntimesJson,
    input.riskSummaryJson,
    input.decision ?? "pending",
    input.actorUserId?.trim() || null,
    now,
  );
  return readSkillRolloutPlanSync(id, workspaceId)!;
}

export function readSkillRolloutPlanSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillRolloutPlanRecord | null {
  const row = getDatabase().prepare(
    `${PLAN_COLUMNS} FROM skill_rollout_plan WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapPlanRecord(row) : null;
}

/** Returns the LATEST plan for a digest (multiple approvals may share a digest over time). */
export function readSkillRolloutPlanByDigestSync(input: {
  workspaceId?: string;
  planDigest: string;
}): SkillRolloutPlanRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${PLAN_COLUMNS} FROM skill_rollout_plan
     WHERE workspace_id = ? AND plan_digest = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspaceId, input.planDigest.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? mapPlanRecord(row) : null;
}

export function listSkillRolloutPlansSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  limit = 100,
): SkillRolloutPlanRecord[] {
  const rows = getDatabase().prepare(
    `${PLAN_COLUMNS} FROM skill_rollout_plan
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapPlanRecord).filter((r): r is SkillRolloutPlanRecord => r !== null);
}

/** Records the decision on a pending plan; returns false if already decided. */
export function decideSkillRolloutPlanSync(
  planId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  decision: "approved" | "rejected",
): boolean {
  const result = getDatabase().prepare(
    `UPDATE skill_rollout_plan SET decision = ?
     WHERE id = ? AND workspace_id = ? AND decision = 'pending'`,
  ).run(decision, planId, workspaceId);
  return result.changes > 0;
}

/** Marks an approved plan consumed atomically (one-time use); returns false if already consumed. */
export function consumeSkillRolloutPlanSync(
  planId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE skill_rollout_plan SET consumed_at = ?
     WHERE id = ? AND workspace_id = ? AND decision = 'approved' AND consumed_at IS NULL`,
  ).run(now, planId, workspaceId);
  return result.changes > 0;
}

function mapPlanRecord(value: Record<string, unknown>): SkillRolloutPlanRecord | null {
  if (
    typeof value.id !== "string"
    || typeof value.workspaceId !== "string"
    || typeof value.rootArtifactDigest !== "string"
    || typeof value.planDigest !== "string"
    || typeof value.policyVersion !== "string"
    || typeof value.closureJson !== "string"
    || typeof value.targetRuntimesJson !== "string"
    || typeof value.riskSummaryJson !== "string"
    || (value.decision !== "pending" && value.decision !== "approved" && value.decision !== "rejected")
    || typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    rootArtifactDigest: value.rootArtifactDigest,
    planDigest: value.planDigest,
    policyVersion: value.policyVersion,
    closureJson: value.closureJson,
    targetRuntimesJson: value.targetRuntimesJson,
    riskSummaryJson: value.riskSummaryJson,
    decision: value.decision,
    actorUserId: typeof value.actorUserId === "string" ? value.actorUserId : undefined,
    createdAt: value.createdAt,
    consumedAt: typeof value.consumedAt === "string" ? value.consumedAt : undefined,
  };
}
