import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { SkillUpgradeApprovalRecord } from "./types.ts";

const APPROVAL_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, skill_id AS skillId,
  from_digest AS fromDigest, to_digest AS toDigest, diff_hash AS diffHash,
  policy_version AS policyVersion, decision, reason,
  actor_user_id AS actorUserId, created_at AS createdAt, consumed_at AS consumedAt`;

export interface CreateSkillUpgradeApprovalInput {
  workspaceId?: string;
  skillId?: string;
  fromDigest: string;
  toDigest: string;
  diffHash: string;
  policyVersion?: string;
  decision: "approved" | "rejected";
  reason?: string;
  actorUserId?: string;
}

/**
 * Records an IMMUTABLE skill-upgrade approval decision bound to the exact
 * `(fromDigest, toDigest, diffHash, policyVersion)` the upgrade was reviewed
 * against. A changed diff or digest invalidates it (a new approval is required).
 *
 * Idempotent per the 4-tuple with first-decision-wins, and ATOMIC under
 * concurrency: `INSERT ... ON CONFLICT DO NOTHING` against the policy-lock
 * unique index lets exactly one caller's row land; the rest conflict and
 * return the surviving row with `created: false`. There is no read-then-insert
 * window for a concurrent duplicate to trip the unique index and throw, and
 * `created` is authoritative so the lifecycle audit fires exactly once.
 */
export function createSkillUpgradeApprovalSync(
  input: CreateSkillUpgradeApprovalInput,
): { record: SkillUpgradeApprovalRecord; created: boolean } {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const fromDigest = input.fromDigest.trim().toLowerCase();
  const toDigest = input.toDigest.trim().toLowerCase();
  const diffHash = input.diffHash.trim().toLowerCase();
  const policyVersion = input.policyVersion?.trim() || "v1";

  const id = `sua-${randomLikeId()}`;
  const now = new Date().toISOString();
  const inserted = db.prepare(
    `INSERT INTO skill_upgrade_approval (
      id, workspace_id, skill_id, from_digest, to_digest, diff_hash,
      policy_version, decision, reason, actor_user_id, created_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (workspace_id, from_digest, to_digest, diff_hash, policy_version) DO NOTHING
    RETURNING id`,
  ).get(
    id,
    workspaceId,
    input.skillId?.trim() || null,
    fromDigest,
    toDigest,
    diffHash,
    policyVersion,
    input.decision,
    input.reason?.trim() || null,
    input.actorUserId?.trim() || null,
    now,
  ) as { id: string } | undefined;

  if (inserted) {
    return { record: readSkillUpgradeApprovalSync(inserted.id, workspaceId)!, created: true };
  }
  // ON CONFLICT fired → a row for this exact lock tuple exists; re-read it. The
  // surviving row is whatever another concurrent caller inserted first.
  const surviving = readSkillUpgradeApprovalByLockSync({ workspaceId, fromDigest, toDigest, diffHash, policyVersion })!;
  return { record: surviving, created: false };
}

export function readSkillUpgradeApprovalSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillUpgradeApprovalRecord | null {
  const row = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_upgrade_approval WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapApprovalRecord(row) : null;
}

export function readSkillUpgradeApprovalByLockSync(input: {
  workspaceId?: string;
  fromDigest: string;
  toDigest: string;
  diffHash: string;
  policyVersion?: string;
}): SkillUpgradeApprovalRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_upgrade_approval
     WHERE workspace_id = ? AND from_digest = ? AND to_digest = ? AND diff_hash = ? AND policy_version = ?`,
  ).get(
    workspaceId,
    input.fromDigest.trim().toLowerCase(),
    input.toDigest.trim().toLowerCase(),
    input.diffHash.trim().toLowerCase(),
    input.policyVersion?.trim() || "v1",
  ) as Record<string, unknown> | undefined;
  return row ? mapApprovalRecord(row) : null;
}

export function listSkillUpgradeApprovalsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillUpgradeApprovalRecord[] {
  const rows = getDatabase().prepare(
    `${APPROVAL_COLUMNS} FROM skill_upgrade_approval WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapApprovalRecord).filter((r): r is SkillUpgradeApprovalRecord => r !== null);
}

/** Marks an approval consumed atomically (one-time use); returns false if already consumed. */
export function consumeSkillUpgradeApprovalSync(
  approvalId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  policyVersion = "v1",
): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE skill_upgrade_approval SET consumed_at = ?
     WHERE id = ? AND workspace_id = ? AND policy_version = ? AND consumed_at IS NULL`,
  ).run(now, approvalId, workspaceId, policyVersion);
  return result.changes > 0;
}

function mapApprovalRecord(value: Record<string, unknown>): SkillUpgradeApprovalRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.fromDigest !== "string" ||
    typeof value.toDigest !== "string" ||
    typeof value.diffHash !== "string" ||
    typeof value.policyVersion !== "string" ||
    (value.decision !== "approved" && value.decision !== "rejected") ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    skillId: typeof value.skillId === "string" ? value.skillId : undefined,
    fromDigest: value.fromDigest,
    toDigest: value.toDigest,
    diffHash: value.diffHash,
    policyVersion: value.policyVersion,
    decision: value.decision,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    actorUserId: typeof value.actorUserId === "string" ? value.actorUserId : undefined,
    createdAt: value.createdAt,
    consumedAt: typeof value.consumedAt === "string" ? value.consumedAt : undefined,
  };
}
