import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  AgentAccessRequestRecord,
  AgentAccessRequestStatus,
  AgentAccessRequestType,
} from "./types.ts";

export interface CreateAgentAccessRequestInput {
  workspaceId?: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType: AgentAccessRequestType;
  targetChannelName?: string;
  reason?: string;
  auditDataJson?: string;
}

export interface CreateAgentAccessRequestResult {
  request: AgentAccessRequestRecord;
  created: boolean;
}

export interface ListAgentAccessRequestsOptions {
  sourceAgentName?: string;
  requesterUserId?: string;
  requestType?: AgentAccessRequestType;
  statuses?: AgentAccessRequestStatus[];
}

export function createAgentAccessRequestSync(input: CreateAgentAccessRequestInput): CreateAgentAccessRequestResult {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sourceAgentName = requireTrimmed(input.sourceAgentName, "sourceAgentName");
  const requesterUserId = requireTrimmed(input.requesterUserId, "requesterUserId");
  const requestType = normalizeRequestType(input.requestType);
  const targetChannelName = normalizeOptional(input.targetChannelName);
  const reason = normalizeOptional(input.reason) ?? "";
  const auditDataJson = normalizeJson(input.auditDataJson ?? "{}");
  ensureWorkspaceExists(workspaceId);
  ensureUserExists(requesterUserId);

  const existing = readPendingDuplicateAgentAccessRequestSync({
    workspaceId,
    sourceAgentName,
    requesterUserId,
    requestType,
    targetChannelName,
  });
  if (existing) {
    return { request: existing, created: false };
  }

  const id = `agent-access-request-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_access_request (
      id,
      workspace_id,
      source_agent_name,
      requester_user_id,
      request_type,
      target_channel_name,
      status,
      reason,
      resolver_user_id,
      resolved_at,
      created_at,
      updated_at,
      fork_invitation_id,
      audit_data_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL, ?)`,
  ).run(
    id,
    workspaceId,
    sourceAgentName,
    requesterUserId,
    requestType,
    targetChannelName ?? null,
    reason,
    now,
    now,
    auditDataJson,
  );

  const request = readAgentAccessRequestSync(id, workspaceId);
  if (!request) {
    throw new Error("Agent access request could not be read after write.");
  }
  return { request, created: true };
}

export function approveAgentAccessRequestSync(input: {
  workspaceId?: string;
  requestId: string;
  resolverUserId: string;
  forkInvitationId?: string;
  auditDataJson?: string;
}): AgentAccessRequestRecord {
  return decideAgentAccessRequest({
    ...input,
    status: "approved",
  });
}

export function rejectAgentAccessRequestSync(input: {
  workspaceId?: string;
  requestId: string;
  resolverUserId: string;
  auditDataJson?: string;
}): AgentAccessRequestRecord {
  return decideAgentAccessRequest({
    ...input,
    status: "rejected",
  });
}

export function cancelAgentAccessRequestSync(input: {
  workspaceId?: string;
  requestId: string;
  resolverUserId: string;
  auditDataJson?: string;
}): AgentAccessRequestRecord {
  return decideAgentAccessRequest({
    ...input,
    status: "cancelled",
  });
}

export function readAgentAccessRequestSync(
  requestId: string,
  workspaceId?: string,
): AgentAccessRequestRecord | null {
  const id = requireTrimmed(requestId, "requestId");
  const conditions = ["id = ?"];
  const params: unknown[] = [id];
  if (workspaceId) {
    conditions.push("workspace_id = ?");
    params.push(workspaceId);
  }
  const row = getDatabase().prepare(agentAccessRequestSelectSql(conditions.join(" AND "))).get(...params) as Record<string, unknown> | undefined;
  return row ? mapAgentAccessRequestRecord(row) : null;
}

export function listAgentAccessRequestsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  options: ListAgentAccessRequestsOptions = {},
): AgentAccessRequestRecord[] {
  const conditions = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.sourceAgentName?.trim()) {
    conditions.push("source_agent_name = ?");
    params.push(options.sourceAgentName.trim());
  }
  if (options.requesterUserId?.trim()) {
    conditions.push("requester_user_id = ?");
    params.push(options.requesterUserId.trim());
  }
  if (options.requestType) {
    conditions.push("request_type = ?");
    params.push(normalizeRequestType(options.requestType));
  }
  if (options.statuses?.length) {
    conditions.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }

  const rows = getDatabase().prepare(
    `${agentAccessRequestSelectSql(conditions.join(" AND "))}
     ORDER BY created_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows
    .map(mapAgentAccessRequestRecord)
    .filter((record): record is AgentAccessRequestRecord => record !== null);
}

function decideAgentAccessRequest(input: {
  workspaceId?: string;
  requestId: string;
  resolverUserId: string;
  forkInvitationId?: string;
  auditDataJson?: string;
  status: "approved" | "rejected" | "cancelled";
}): AgentAccessRequestRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const request = readAgentAccessRequestSync(input.requestId, workspaceId);
  if (!request) {
    throw new Error(`Agent access request "${input.requestId}" does not exist.`);
  }
  if (request.status !== "pending") {
    throw new Error(`Agent access request "${input.requestId}" is not pending.`);
  }
  const resolverUserId = requireTrimmed(input.resolverUserId, "resolverUserId");
  ensureUserExists(resolverUserId);
  const now = new Date().toISOString();
  const auditDataJson = normalizeJson(input.auditDataJson ?? request.auditDataJson);
  getDatabase().prepare(
    `UPDATE agent_access_request
     SET status = ?,
         resolver_user_id = ?,
         resolved_at = ?,
         updated_at = ?,
         fork_invitation_id = ?,
         audit_data_json = ?
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(
    input.status,
    resolverUserId,
    now,
    now,
    normalizeOptional(input.forkInvitationId) ?? request.forkInvitationId ?? null,
    auditDataJson,
    request.id,
    workspaceId,
  );

  const updated = readAgentAccessRequestSync(request.id, workspaceId);
  if (!updated) {
    throw new Error(`Agent access request "${request.id}" could not be read after decision.`);
  }
  return updated;
}

function readPendingDuplicateAgentAccessRequestSync(input: {
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType: AgentAccessRequestType;
  targetChannelName?: string;
}): AgentAccessRequestRecord | null {
  const row = getDatabase().prepare(
    `SELECT id
     FROM agent_access_request
     WHERE workspace_id = ?
       AND source_agent_name = ?
       AND requester_user_id = ?
       AND request_type = ?
       AND COALESCE(target_channel_name, '') = COALESCE(?, '')
       AND status = 'pending'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(
    input.workspaceId,
    input.sourceAgentName,
    input.requesterUserId,
    input.requestType,
    input.targetChannelName ?? null,
  ) as { id: string } | undefined;
  return row ? readAgentAccessRequestSync(row.id, input.workspaceId) : null;
}

function agentAccessRequestSelectSql(whereClause: string): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    source_agent_name AS "sourceAgentName",
    requester_user_id AS "requesterUserId",
    request_type AS "requestType",
    target_channel_name AS "targetChannelName",
    status,
    reason,
    resolver_user_id AS "resolverUserId",
    resolved_at AS "resolvedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    fork_invitation_id AS "forkInvitationId",
    audit_data_json AS "auditDataJson"
   FROM agent_access_request
   WHERE ${whereClause}`;
}

function mapAgentAccessRequestRecord(row: Record<string, unknown>): AgentAccessRequestRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.sourceAgentName !== "string" ||
    typeof row.requesterUserId !== "string" ||
    !isAgentAccessRequestType(row.requestType) ||
    !isAgentAccessRequestStatus(row.status) ||
    typeof row.reason !== "string" ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string" ||
    typeof row.auditDataJson !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceAgentName: row.sourceAgentName,
    requesterUserId: row.requesterUserId,
    requestType: row.requestType,
    targetChannelName: typeof row.targetChannelName === "string" ? row.targetChannelName : undefined,
    status: row.status,
    reason: row.reason,
    resolverUserId: typeof row.resolverUserId === "string" ? row.resolverUserId : undefined,
    resolvedAt: typeof row.resolvedAt === "string" ? row.resolvedAt : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    forkInvitationId: typeof row.forkInvitationId === "string" ? row.forkInvitationId : undefined,
    auditDataJson: row.auditDataJson,
  };
}

function normalizeRequestType(value: AgentAccessRequestType): AgentAccessRequestType {
  if (!isAgentAccessRequestType(value)) {
    throw new Error("requestType must be fork_copy or channel_use.");
  }
  return value;
}

function isAgentAccessRequestType(value: unknown): value is AgentAccessRequestType {
  return value === "fork_copy" || value === "channel_use";
}

function isAgentAccessRequestStatus(value: unknown): value is AgentAccessRequestStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "cancelled";
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function normalizeJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return "{}";
  }
}

function ensureWorkspaceExists(workspaceId: string): void {
  const row = getDatabase()
    .prepare("SELECT 1 FROM workspace WHERE id = ? LIMIT 1")
    .get(workspaceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Workspace "${workspaceId}" does not exist.`);
  }
}

function ensureUserExists(userId: string): void {
  const row = getDatabase()
    .prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`User "${userId}" does not exist.`);
  }
}
