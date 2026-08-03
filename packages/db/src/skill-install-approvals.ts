import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { SkillInstallApprovalRecord, SkillInstallApprovalRiskItem } from "./types.ts";

const APPROVAL_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, skill_id AS skillId,
  artifact_digest AS artifactDigest, release_lock_digest AS releaseLockDigest,
  policy_version AS policyVersion, risk_decision_digest AS riskDecisionDigest,
  decision, risk_items_json AS riskItemsJson, reason,
  actor_user_id AS actorUserId, created_at AS createdAt, consumed_at AS consumedAt`;

export interface CreateSkillInstallApprovalInput {
  workspaceId?: string;
  skillId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  policyVersion?: string;
  riskDecisionDigest: string;
  decision: "approved" | "rejected";
  riskItems: SkillInstallApprovalRiskItem[];
  reason?: string;
  actorUserId?: string;
}

/**
 * Records an IMMUTABLE first-install approval decision bound to the exact
 * `(artifactDigest, releaseLockDigest, policyVersion, riskDecisionDigest)` the
 * artifact was reviewed against. A changed artifact, release lock or risk set
 * invalidates it — the plan gate re-derives the digest and requires a matching
 * unconsumed record before a risk-bearing install proceeds.
 *
 * Each call inserts a FRESH one-shot approval: a consumed approval can never be
 * reused (the gate rejects it), and the admin can approve the same tuple again
 * for a later install without being trapped by a prior consumed/rejected row.
 */
export function createSkillInstallApprovalSync(input: CreateSkillInstallApprovalInput): SkillInstallApprovalRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `sia-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_install_approval (
      id, workspace_id, skill_id, artifact_digest, release_lock_digest,
      policy_version, risk_decision_digest, decision, risk_items_json,
      reason, actor_user_id, created_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    workspaceId,
    input.skillId?.trim() || null,
    input.artifactDigest.trim().toLowerCase(),
    input.releaseLockDigest.trim().toLowerCase(),
    input.policyVersion?.trim() || "v1",
    input.riskDecisionDigest.trim().toLowerCase(),
    input.decision,
    JSON.stringify(input.riskItems),
    input.reason?.trim() || null,
    input.actorUserId?.trim() || null,
    now,
  );
  return readSkillInstallApprovalSync(id, workspaceId)!;
}

export function readSkillInstallApprovalSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillInstallApprovalRecord | null {
  const row = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_install_approval WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapApprovalRecord(row) : null;
}

export function readSkillInstallApprovalByLockSync(input: {
  workspaceId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  policyVersion?: string;
  riskDecisionDigest: string;
  decision?: "approved" | "rejected";
}): SkillInstallApprovalRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const decisionClause = input.decision ? " AND decision = ?" : "";
  const params: unknown[] = [
    workspaceId,
    input.artifactDigest.trim().toLowerCase(),
    input.releaseLockDigest.trim().toLowerCase(),
    input.policyVersion?.trim() || "v1",
    input.riskDecisionDigest.trim().toLowerCase(),
  ];
  if (input.decision) {
    params.push(input.decision);
  }
  const row = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_install_approval
     WHERE workspace_id = ? AND artifact_digest = ? AND release_lock_digest = ?
       AND policy_version = ? AND risk_decision_digest = ?${decisionClause}`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? mapApprovalRecord(row) : null;
}

export function listSkillInstallApprovalsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  limit = 100,
): SkillInstallApprovalRecord[] {
  const rows = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_install_approval
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(workspaceId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapApprovalRecord).filter((r): r is SkillInstallApprovalRecord => r !== null);
}

/** Marks an approval consumed atomically (one-time use); returns false if already consumed. */
export function consumeSkillInstallApprovalSync(
  approvalId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  policyVersion = "v1",
): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE skill_install_approval SET consumed_at = ?
     WHERE id = ? AND workspace_id = ? AND policy_version = ? AND consumed_at IS NULL`,
  ).run(now, approvalId, workspaceId, policyVersion);
  return result.changes > 0;
}

function mapApprovalRecord(value: Record<string, unknown>): SkillInstallApprovalRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.artifactDigest !== "string" ||
    typeof value.releaseLockDigest !== "string" ||
    typeof value.policyVersion !== "string" ||
    typeof value.riskDecisionDigest !== "string" ||
    (value.decision !== "approved" && value.decision !== "rejected") ||
    typeof value.riskItemsJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    skillId: typeof value.skillId === "string" ? value.skillId : undefined,
    artifactDigest: value.artifactDigest,
    releaseLockDigest: value.releaseLockDigest,
    policyVersion: value.policyVersion,
    riskDecisionDigest: value.riskDecisionDigest,
    decision: value.decision,
    riskItems: parseRiskItems(value.riskItemsJson),
    reason: typeof value.reason === "string" ? value.reason : undefined,
    actorUserId: typeof value.actorUserId === "string" ? value.actorUserId : undefined,
    createdAt: value.createdAt,
    consumedAt: typeof value.consumedAt === "string" ? value.consumedAt : undefined,
  };
}

function parseRiskItems(json: string): SkillInstallApprovalRiskItem[] {
  try {
    const parsed = JSON.parse(json) as SkillInstallApprovalRiskItem[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            typeof item.key === "string" &&
            typeof item.description === "string" &&
            (item.category === "script" ||
              item.category === "network" ||
              item.category === "mcp_tool" ||
              item.category === "write"),
        )
      : [];
  } catch {
    return [];
  }
}
