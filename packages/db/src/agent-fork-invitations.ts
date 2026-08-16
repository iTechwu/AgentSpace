import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  AgentForkInvitationStatus,
  StoredAgentForkInvitationRecord,
  StoredAgentForkSnapshotRecord,
} from "./types.ts";

export interface CreateAgentForkInvitationRecordInput {
  workspaceId?: string;
  sourceAgentName: string;
  targetUserId: string;
  createdByUserId: string;
  optionsJson: string;
  snapshotJson: string;
}

export interface CreateAgentForkInvitationRecordResult {
  invitation: StoredAgentForkInvitationRecord;
  snapshot: StoredAgentForkSnapshotRecord;
  created: boolean;
}

export interface ListAgentForkInvitationsOptions {
  sourceAgentName?: string;
  targetUserId?: string;
  createdByUserId?: string;
  statuses?: AgentForkInvitationStatus[];
}

export function createAgentForkInvitationSync(
  input: CreateAgentForkInvitationRecordInput,
): CreateAgentForkInvitationRecordResult {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sourceAgentName = normalizeRequired(input.sourceAgentName, "sourceAgentName");
  const targetUserId = normalizeRequired(input.targetUserId, "targetUserId");
  const createdByUserId = normalizeRequired(input.createdByUserId, "createdByUserId");
  const existing = readPendingAgentForkInvitationSync(workspaceId, sourceAgentName, targetUserId);
  if (existing) {
    const snapshot = readAgentForkSnapshotByInvitationSync(workspaceId, existing.id);
    if (!snapshot) {
      throw new Error("agent.fork.snapshot_not_found");
    }
    return { invitation: existing, snapshot, created: false };
  }

  const now = new Date().toISOString();
  const invitationId = `agent-fork-invitation-${randomLikeId()}`;
  const snapshotId = `agent-fork-snapshot-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO agent_fork_invitation (
      id,
      workspace_id,
      source_agent_name,
      target_user_id,
      status,
      options_json,
      created_by_user_id,
      created_at,
      updated_at,
      accepted_at,
      revoked_at,
      accepted_agent_name,
      accepted_runtime_id
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(invitationId, workspaceId, sourceAgentName, targetUserId, normalizeJson(input.optionsJson), createdByUserId, now, now);

  db.prepare(
    `INSERT INTO agent_fork_snapshot (
      id,
      workspace_id,
      invitation_id,
      source_agent_name,
      snapshot_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(snapshotId, workspaceId, invitationId, sourceAgentName, normalizeJson(input.snapshotJson), now);

  const invitation = readAgentForkInvitationSync(invitationId, workspaceId);
  const snapshot = readAgentForkSnapshotByInvitationSync(workspaceId, invitationId);
  if (!invitation || !snapshot) {
    throw new Error("agent.fork.invitation_create_failed");
  }
  return { invitation, snapshot, created: true };
}

export function readAgentForkInvitationSync(
  invitationId: string,
  workspaceId?: string,
): StoredAgentForkInvitationRecord | null {
  const id = normalizeRequired(invitationId, "invitationId");
  const db = getDatabase();
  const row = workspaceId
    ? db.prepare(agentForkInvitationSelectSql("id = ? AND workspace_id = ?")).get(id, workspaceId)
    : db.prepare(agentForkInvitationSelectSql("id = ?")).get(id);
  return row ? mapAgentForkInvitationRecord(row as Record<string, unknown>) : null;
}

export function readAgentForkSnapshotByInvitationSync(
  workspaceId: string,
  invitationId: string,
): StoredAgentForkSnapshotRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `${agentForkSnapshotSelectSql("workspace_id = ? AND invitation_id = ?")}
     LIMIT 1`,
  ).get(workspaceId, invitationId) as Record<string, unknown> | undefined;
  return row ? mapAgentForkSnapshotRecord(row) : null;
}

export function listAgentForkInvitationsSync(
  workspaceId: string,
  options?: ListAgentForkInvitationsOptions,
): StoredAgentForkInvitationRecord[] {
  const conditions = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options?.sourceAgentName) {
    conditions.push("source_agent_name = ?");
    params.push(options.sourceAgentName.trim());
  }
  if (options?.targetUserId) {
    conditions.push("target_user_id = ?");
    params.push(options.targetUserId.trim());
  }
  if (options?.createdByUserId) {
    conditions.push("created_by_user_id = ?");
    params.push(options.createdByUserId.trim());
  }
  const statuses = options?.statuses?.length ? options.statuses : ["pending"];
  conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);

  const rows = getDatabase().prepare(
    `${agentForkInvitationSelectSql(conditions.join(" AND "))}
     ORDER BY created_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows
    .map(mapAgentForkInvitationRecord)
    .filter((record): record is StoredAgentForkInvitationRecord => record !== null);
}

export function acceptAgentForkInvitationSync(input: {
  workspaceId?: string;
  invitationId: string;
  acceptedAgentName: string;
  acceptedRuntimeId: string;
}): StoredAgentForkInvitationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const invitationId = normalizeRequired(input.invitationId, "invitationId");
  const acceptedAgentName = normalizeRequired(input.acceptedAgentName, "acceptedAgentName");
  const acceptedRuntimeId = normalizeRequired(input.acceptedRuntimeId, "acceptedRuntimeId");
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE agent_fork_invitation
     SET status = 'accepted',
         accepted_at = ?,
         updated_at = ?,
         accepted_agent_name = ?,
         accepted_runtime_id = ?
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(now, now, acceptedAgentName, acceptedRuntimeId, invitationId, workspaceId);
  if (result.changes === 0) {
    return null;
  }
  return readAgentForkInvitationSync(invitationId, workspaceId);
}

export function revokeAgentForkInvitationSync(input: {
  workspaceId?: string;
  invitationId: string;
}): StoredAgentForkInvitationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const invitationId = normalizeRequired(input.invitationId, "invitationId");
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE agent_fork_invitation
     SET status = 'revoked',
         revoked_at = ?,
         updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(now, now, invitationId, workspaceId);
  if (result.changes === 0) {
    return null;
  }
  return readAgentForkInvitationSync(invitationId, workspaceId);
}

function readPendingAgentForkInvitationSync(
  workspaceId: string,
  sourceAgentName: string,
  targetUserId: string,
): StoredAgentForkInvitationRecord | null {
  const row = getDatabase().prepare(
    `${agentForkInvitationSelectSql("workspace_id = ? AND source_agent_name = ? AND target_user_id = ? AND status = 'pending'")}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(workspaceId, sourceAgentName, targetUserId) as Record<string, unknown> | undefined;
  return row ? mapAgentForkInvitationRecord(row) : null;
}

function agentForkInvitationSelectSql(whereClause: string): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    source_agent_name AS "sourceAgentName",
    target_user_id AS "targetUserId",
    status,
    options_json AS "optionsJson",
    created_by_user_id AS "createdByUserId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    accepted_at AS "acceptedAt",
    revoked_at AS "revokedAt",
    accepted_agent_name AS "acceptedAgentName",
    accepted_runtime_id AS "acceptedRuntimeId"
   FROM agent_fork_invitation
   WHERE ${whereClause}`;
}

function agentForkSnapshotSelectSql(whereClause: string): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    invitation_id AS "invitationId",
    source_agent_name AS "sourceAgentName",
    snapshot_json AS "snapshotJson",
    created_at AS "createdAt"
   FROM agent_fork_snapshot
   WHERE ${whereClause}`;
}

function mapAgentForkInvitationRecord(row: Record<string, unknown>): StoredAgentForkInvitationRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.sourceAgentName !== "string" ||
    typeof row.targetUserId !== "string" ||
    !isAgentForkInvitationStatus(row.status) ||
    typeof row.optionsJson !== "string" ||
    typeof row.createdByUserId !== "string" ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceAgentName: row.sourceAgentName,
    targetUserId: row.targetUserId,
    status: row.status,
    optionsJson: row.optionsJson,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acceptedAt: typeof row.acceptedAt === "string" ? row.acceptedAt : undefined,
    revokedAt: typeof row.revokedAt === "string" ? row.revokedAt : undefined,
    acceptedAgentName: typeof row.acceptedAgentName === "string" ? row.acceptedAgentName : undefined,
    acceptedRuntimeId: typeof row.acceptedRuntimeId === "string" ? row.acceptedRuntimeId : undefined,
  };
}

function mapAgentForkSnapshotRecord(row: Record<string, unknown>): StoredAgentForkSnapshotRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.invitationId !== "string" ||
    typeof row.sourceAgentName !== "string" ||
    typeof row.snapshotJson !== "string" ||
    typeof row.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    invitationId: row.invitationId,
    sourceAgentName: row.sourceAgentName,
    snapshotJson: row.snapshotJson,
    createdAt: row.createdAt,
  };
}

function isAgentForkInvitationStatus(value: unknown): value is AgentForkInvitationStatus {
  return value === "pending" || value === "accepted" || value === "revoked" || value === "expired";
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeJson(value: string): string {
  if (!value.trim()) {
    return "{}";
  }
  JSON.parse(value);
  return value;
}
