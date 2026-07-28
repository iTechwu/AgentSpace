import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  DocumentAgentAccessRecord,
  DocumentAgentAccessRole,
  DocumentPermissionRequestExternalProvider,
  DocumentPermissionRequestRecord,
  DocumentPermissionRequestStatus,
} from "./types.ts";

export function grantDocumentAgentAccessSync(input: {
  workspaceId?: string;
  documentId: string;
  subjectId: string;
  role: DocumentAgentAccessRole;
  grantedByUserId: string;
}): DocumentAgentAccessRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const documentId = requireTrimmed(input.documentId, "documentId");
  const subjectId = requireTrimmed(input.subjectId, "subjectId");
  const grantedByUserId = requireTrimmed(input.grantedByUserId, "grantedByUserId");
  assertAgentAssignableRole(input.role);
  ensureWorkspaceExists(workspaceId);
  ensureUserExists(grantedByUserId);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO document_agent_access (
      id,
      workspace_id,
      document_id,
      subject_type,
      subject_id,
      role,
      scope,
      granted_by_user_id,
      created_at,
      updated_at,
      revoked_at
    ) VALUES (?, ?, ?, 'agent', ?, ?, 'document', ?, ?, ?, NULL)
    ON CONFLICT(workspace_id, document_id, subject_type, subject_id) DO UPDATE SET
      role = excluded.role,
      granted_by_user_id = excluded.granted_by_user_id,
      updated_at = excluded.updated_at,
      revoked_at = NULL`,
  ).run(`document-agent-access-${randomLikeId()}`, workspaceId, documentId, subjectId, input.role, grantedByUserId, now, now);

  const grant = readDocumentAgentAccessSync({
    workspaceId,
    documentId,
    subjectId,
  });
  if (!grant) {
    throw new Error("Document agent access grant could not be read after write.");
  }
  return grant;
}

export function revokeDocumentAgentAccessSync(input: {
  workspaceId?: string;
  documentId: string;
  subjectId: string;
}): DocumentAgentAccessRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const documentId = requireTrimmed(input.documentId, "documentId");
  const subjectId = requireTrimmed(input.subjectId, "subjectId");
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE document_agent_access
     SET revoked_at = COALESCE(revoked_at, ?),
         updated_at = ?
     WHERE workspace_id = ?
       AND document_id = ?
       AND subject_type = 'agent'
       AND subject_id = ?`,
  ).run(now, now, workspaceId, documentId, subjectId);

  return readDocumentAgentAccessSync({
    workspaceId,
    documentId,
    subjectId,
    includeRevoked: true,
  });
}

export function readDocumentAgentAccessSync(input: {
  workspaceId?: string;
  documentId: string;
  subjectId: string;
  includeRevoked?: boolean;
}): DocumentAgentAccessRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const whereRevoked = input.includeRevoked ? "" : "AND revoked_at IS NULL";
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      document_id AS documentId,
      subject_type AS subjectType,
      subject_id AS subjectId,
      role,
      scope,
      granted_by_user_id AS grantedByUserId,
      created_at AS createdAt,
      updated_at AS updatedAt,
      revoked_at AS revokedAt
     FROM document_agent_access
     WHERE workspace_id = ?
       AND document_id = ?
       AND subject_type = 'agent'
       AND subject_id = ?
       ${whereRevoked}
     LIMIT 1`,
  ).get(workspaceId, input.documentId.trim(), input.subjectId.trim()) as Record<string, unknown> | undefined;

  return row ? mapDocumentAgentAccessRecord(row) : null;
}

export function listDocumentAgentAccessSync(input: {
  workspaceId?: string;
  documentId?: string;
  subjectId?: string;
  includeRevoked?: boolean;
} = {}): DocumentAgentAccessRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];

  if (input.documentId?.trim()) {
    where.push("document_id = ?");
    params.push(input.documentId.trim());
  }
  if (input.subjectId?.trim()) {
    where.push("subject_type = 'agent'");
    where.push("subject_id = ?");
    params.push(input.subjectId.trim());
  }
  if (!input.includeRevoked) {
    where.push("revoked_at IS NULL");
  }

  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      document_id AS documentId,
      subject_type AS subjectType,
      subject_id AS subjectId,
      role,
      scope,
      granted_by_user_id AS grantedByUserId,
      created_at AS createdAt,
      updated_at AS updatedAt,
      revoked_at AS revokedAt
     FROM document_agent_access
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, created_at DESC, id ASC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows
    .map(mapDocumentAgentAccessRecord)
    .filter((record): record is DocumentAgentAccessRecord => record !== null);
}

export function createDocumentPermissionRequestSync(input: {
  workspaceId?: string;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  externalUrl?: string;
  requestedRole: DocumentAgentAccessRole;
  requestedByAgentName: string;
  requestedForChannelName?: string;
  triggeredByUserId?: string;
  reason: string;
  sourceTaskId?: string;
}): DocumentPermissionRequestRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const requestedByAgentName = requireTrimmed(input.requestedByAgentName, "requestedByAgentName");
  const reason = requireTrimmed(input.reason, "reason");
  const documentId = normalizeOptional(input.documentId);
  const externalProvider = normalizeExternalProvider(input.externalProvider);
  const externalFileId = normalizeOptional(input.externalFileId);
  const externalUrl = normalizeOptional(input.externalUrl);
  const requestedForChannelName = normalizeOptional(input.requestedForChannelName);
  const triggeredByUserId = normalizeOptional(input.triggeredByUserId);
  const sourceTaskId = normalizeOptional(input.sourceTaskId);
  assertAgentAssignableRole(input.requestedRole);
  ensureWorkspaceExists(workspaceId);
  if (!documentId && !externalFileId && !externalUrl) {
    throw new Error("documentId, externalFileId, or externalUrl is required.");
  }
  if ((externalFileId || externalUrl) && !externalProvider) {
    throw new Error("externalProvider is required for external document permission requests.");
  }
  if (triggeredByUserId) {
    ensureUserExists(triggeredByUserId);
  }

  const existing = findDuplicatePendingRequest({
    workspaceId,
    documentId,
    externalProvider,
    externalFileId,
    requestedRole: input.requestedRole,
    requestedByAgentName,
    requestedForChannelName,
  });
  if (existing) {
    return existing;
  }

  const id = `document-permission-request-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO document_permission_request (
      id,
      workspace_id,
      document_id,
      external_provider,
      external_file_id,
      external_url,
      requested_role,
      requested_by_agent_name,
      requested_for_channel_name,
      triggered_by_user_id,
      reason,
      status,
      decided_by_user_id,
      decision_note,
      source_task_id,
      created_at,
      decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
  ).run(
    id,
    workspaceId,
    documentId ?? null,
    externalProvider ?? null,
    externalFileId ?? null,
    externalUrl ?? null,
    input.requestedRole,
    requestedByAgentName,
    requestedForChannelName ?? null,
    triggeredByUserId ?? null,
    reason,
    sourceTaskId ?? null,
    now,
  );

  const request = readDocumentPermissionRequestSync(id);
  if (!request) {
    throw new Error("Document permission request could not be read after write.");
  }
  return request;
}

export function approveDocumentPermissionRequestSync(input: {
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  const request = readDocumentPermissionRequestSync(input.requestId);
  if (!request) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  if (request.status !== "pending") {
    throw new Error(`Document permission request "${input.requestId}" is not pending.`);
  }
  if (!request.documentId) {
    throw new Error("Cannot approve a document permission request before it is linked to a channel document.");
  }
  const decidedByUserId = requireTrimmed(input.decidedByUserId, "decidedByUserId");
  ensureUserExists(decidedByUserId);
  const now = new Date().toISOString();

  getDatabase().prepare(
    `UPDATE document_permission_request
     SET status = 'approved',
         decided_by_user_id = ?,
         decision_note = ?,
         decided_at = ?
     WHERE id = ?`,
  ).run(decidedByUserId, normalizeOptional(input.decisionNote) ?? null, now, request.id);

  grantDocumentAgentAccessSync({
    workspaceId: request.workspaceId,
    documentId: request.documentId,
    subjectId: request.requestedByAgentName,
    role: request.requestedRole,
    grantedByUserId: decidedByUserId,
  });

  return readDocumentPermissionRequestSync(request.id) ?? {
    ...request,
    status: "approved",
    decidedByUserId,
    decisionNote: normalizeOptional(input.decisionNote),
    decidedAt: now,
  };
}

export function linkDocumentPermissionRequestDocumentSync(input: {
  requestId: string;
  documentId: string;
}): DocumentPermissionRequestRecord {
  const request = readDocumentPermissionRequestSync(input.requestId);
  if (!request) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  const documentId = requireTrimmed(input.documentId, "documentId");

  getDatabase().prepare(
    `UPDATE document_permission_request
     SET document_id = ?
     WHERE id = ?`,
  ).run(documentId, request.id);

  const updated = readDocumentPermissionRequestSync(request.id);
  if (!updated) {
    throw new Error(`Document permission request "${request.id}" could not be read after linking document.`);
  }
  return updated;
}

export function rejectDocumentPermissionRequestSync(input: {
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  return decideDocumentPermissionRequest({
    ...input,
    status: "rejected",
  });
}

export function cancelDocumentPermissionRequestSync(input: {
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
}): DocumentPermissionRequestRecord {
  return decideDocumentPermissionRequest({
    ...input,
    status: "cancelled",
  });
}

export function listDocumentPermissionRequestsSync(input: {
  workspaceId?: string;
  status?: DocumentPermissionRequestStatus;
  requestedByAgentName?: string;
  documentId?: string;
} = {}): DocumentPermissionRequestRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.requestedByAgentName?.trim()) {
    where.push("requested_by_agent_name = ?");
    params.push(input.requestedByAgentName.trim());
  }
  if (input.documentId?.trim()) {
    where.push("document_id = ?");
    params.push(input.documentId.trim());
  }

  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      document_id AS documentId,
      external_provider AS externalProvider,
      external_file_id AS externalFileId,
      external_url AS externalUrl,
      requested_role AS requestedRole,
      requested_by_agent_name AS requestedByAgentName,
      requested_for_channel_name AS requestedForChannelName,
      triggered_by_user_id AS triggeredByUserId,
      reason,
      status,
      decided_by_user_id AS decidedByUserId,
      decision_note AS decisionNote,
      source_task_id AS sourceTaskId,
      created_at AS createdAt,
      decided_at AS decidedAt
     FROM document_permission_request
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id ASC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows
    .map(mapDocumentPermissionRequestRecord)
    .filter((record): record is DocumentPermissionRequestRecord => record !== null);
}

export function readDocumentPermissionRequestSync(requestId: string): DocumentPermissionRequestRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      document_id AS documentId,
      external_provider AS externalProvider,
      external_file_id AS externalFileId,
      external_url AS externalUrl,
      requested_role AS requestedRole,
      requested_by_agent_name AS requestedByAgentName,
      requested_for_channel_name AS requestedForChannelName,
      triggered_by_user_id AS triggeredByUserId,
      reason,
      status,
      decided_by_user_id AS decidedByUserId,
      decision_note AS decisionNote,
      source_task_id AS sourceTaskId,
      created_at AS createdAt,
      decided_at AS decidedAt
     FROM document_permission_request
     WHERE id = ?
     LIMIT 1`,
  ).get(requestId.trim()) as Record<string, unknown> | undefined;

  return row ? mapDocumentPermissionRequestRecord(row) : null;
}

function decideDocumentPermissionRequest(input: {
  requestId: string;
  decidedByUserId: string;
  decisionNote?: string;
  status: "rejected" | "cancelled";
}): DocumentPermissionRequestRecord {
  const request = readDocumentPermissionRequestSync(input.requestId);
  if (!request) {
    throw new Error(`Document permission request "${input.requestId}" does not exist.`);
  }
  if (request.status !== "pending") {
    throw new Error(`Document permission request "${input.requestId}" is not pending.`);
  }
  const decidedByUserId = requireTrimmed(input.decidedByUserId, "decidedByUserId");
  ensureUserExists(decidedByUserId);
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE document_permission_request
     SET status = ?,
         decided_by_user_id = ?,
         decision_note = ?,
         decided_at = ?
     WHERE id = ?`,
  ).run(input.status, decidedByUserId, normalizeOptional(input.decisionNote) ?? null, now, request.id);

  const updated = readDocumentPermissionRequestSync(request.id);
  if (!updated) {
    throw new Error(`Document permission request "${request.id}" could not be read after decision.`);
  }
  return updated;
}

function findDuplicatePendingRequest(input: {
  workspaceId: string;
  documentId?: string;
  externalProvider?: DocumentPermissionRequestExternalProvider;
  externalFileId?: string;
  requestedRole: DocumentAgentAccessRole;
  requestedByAgentName: string;
  requestedForChannelName?: string;
}): DocumentPermissionRequestRecord | null {
  if (input.documentId) {
    const row = getDatabase().prepare(
      `SELECT id
       FROM document_permission_request
       WHERE workspace_id = ?
         AND requested_by_agent_name = ?
         AND requested_role = ?
         AND document_id = ?
         AND COALESCE(requested_for_channel_name, '') = COALESCE(?, '')
         AND status = 'pending'
       LIMIT 1`,
    ).get(
      input.workspaceId,
      input.requestedByAgentName,
      input.requestedRole,
      input.documentId,
      input.requestedForChannelName ?? null,
    ) as { id: string } | undefined;
    return row ? readDocumentPermissionRequestSync(row.id) : null;
  }
  if (input.externalProvider && input.externalFileId) {
    const row = getDatabase().prepare(
      `SELECT id
       FROM document_permission_request
       WHERE workspace_id = ?
         AND requested_by_agent_name = ?
         AND requested_role = ?
         AND external_provider = ?
         AND external_file_id = ?
         AND COALESCE(requested_for_channel_name, '') = COALESCE(?, '')
         AND status = 'pending'
       LIMIT 1`,
    ).get(
      input.workspaceId,
      input.requestedByAgentName,
      input.requestedRole,
      input.externalProvider,
      input.externalFileId,
      input.requestedForChannelName ?? null,
    ) as { id: string } | undefined;
    return row ? readDocumentPermissionRequestSync(row.id) : null;
  }
  return null;
}

function mapDocumentAgentAccessRecord(value: Record<string, unknown>): DocumentAgentAccessRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.documentId !== "string" ||
    value.subjectType !== "agent" ||
    typeof value.subjectId !== "string" ||
    !isAgentAssignableRole(value.role) ||
    value.scope !== "document" ||
    typeof value.grantedByUserId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    documentId: value.documentId,
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    role: value.role,
    scope: "document",
    grantedByUserId: value.grantedByUserId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}

function mapDocumentPermissionRequestRecord(value: Record<string, unknown>): DocumentPermissionRequestRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isAgentAssignableRole(value.requestedRole) ||
    typeof value.requestedByAgentName !== "string" ||
    typeof value.reason !== "string" ||
    !isPermissionRequestStatus(value.status) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const externalProvider = normalizeExternalProvider(
    typeof value.externalProvider === "string" ? value.externalProvider : undefined,
  );
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    documentId: typeof value.documentId === "string" ? value.documentId : undefined,
    externalProvider,
    externalFileId: typeof value.externalFileId === "string" ? value.externalFileId : undefined,
    externalUrl: typeof value.externalUrl === "string" ? value.externalUrl : undefined,
    requestedRole: value.requestedRole,
    requestedByAgentName: value.requestedByAgentName,
    requestedForChannelName: typeof value.requestedForChannelName === "string" ? value.requestedForChannelName : undefined,
    triggeredByUserId: typeof value.triggeredByUserId === "string" ? value.triggeredByUserId : undefined,
    reason: value.reason,
    status: value.status,
    decidedByUserId: typeof value.decidedByUserId === "string" ? value.decidedByUserId : undefined,
    decisionNote: typeof value.decisionNote === "string" ? value.decisionNote : undefined,
    sourceTaskId: typeof value.sourceTaskId === "string" ? value.sourceTaskId : undefined,
    createdAt: value.createdAt,
    decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : undefined,
  };
}

function assertAgentAssignableRole(role: string): asserts role is DocumentAgentAccessRole {
  if (!isAgentAssignableRole(role)) {
    throw new Error("role must be viewer, editor, or forwarder.");
  }
}

function isAgentAssignableRole(value: unknown): value is DocumentAgentAccessRole {
  return value === "viewer" || value === "editor" || value === "forwarder";
}

function isPermissionRequestStatus(value: unknown): value is DocumentPermissionRequestStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "cancelled";
}

function normalizeExternalProvider(value: string | undefined): DocumentPermissionRequestExternalProvider | undefined {
  if (value === "notion" || value === "microsoft_365") {
    return value;
  }
  return undefined;
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
