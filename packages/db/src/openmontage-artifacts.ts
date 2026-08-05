import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { readStoredAttachmentSync, type StoredAttachmentRecord } from "./attachments.ts";

const DEFAULT_GRANT_TTL_SECONDS = 300;
const MAX_GRANT_TTL_SECONDS = 900;
const MAX_OUTPUT_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const OUTPUT_ROLES = new Set([
  "preview_video",
  "final_video",
  "thumbnail",
  "qa_report",
  "subtitle",
]);
const OUTPUT_MEDIA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "image/png",
  "image/jpeg",
  "application/json",
  "text/vtt",
  "application/x-subrip",
]);

export interface OpenMontageArtifactReadGrantRecord {
  id: string;
  workspaceId: string;
  jobId: string;
  attachmentId: string;
  operation: "READ";
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface OpenMontageArtifactWriteGrantRecord {
  id: string;
  workspaceId: string;
  jobId: string;
  operation: "WRITE";
  role: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export class OpenMontageArtifactGrantError extends Error {}

export function issueOpenMontageArtifactReadGrantSync(input: {
  workspaceId: string;
  jobId: string;
  attachmentId: string;
  ttlSeconds?: number;
  now?: string;
}): { grant: OpenMontageArtifactReadGrantRecord; token: string } {
  const workspaceId = requiredIdentifier(input.workspaceId, "workspaceId");
  const jobId = requiredIdentifier(input.jobId, "jobId");
  const attachmentId = requiredIdentifier(input.attachmentId, "attachmentId");
  const now = parseTimestamp(input.now ?? new Date().toISOString(), "now");
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_GRANT_TTL_SECONDS) {
    throw new OpenMontageArtifactGrantError(
      `ttlSeconds must be an integer between 1 and ${MAX_GRANT_TTL_SECONDS}`,
    );
  }

  const db = getDatabase();
  const access = db.prepare(
    `SELECT binding.channel_name AS "jobChannelName",
            attachment.channel_name AS "attachmentChannelName"
       FROM openmontage_job_link link
       JOIN openmontage_chat_binding binding
         ON binding.job_id = link.job_id AND binding.workspace_id = link.workspace_id
       JOIN attachment
         ON attachment.workspace_id = link.workspace_id AND attachment.id = ?
      WHERE link.job_id = ? AND link.workspace_id = ?`,
  ).get(attachmentId, jobId, workspaceId) as
    | { jobChannelName?: string; attachmentChannelName?: string }
    | undefined;
  if (!access) {
    throw new OpenMontageArtifactGrantError("OpenMontage Job or attachment is not available");
  }
  if (!access.jobChannelName || access.attachmentChannelName !== access.jobChannelName) {
    throw new OpenMontageArtifactGrantError(
      "OpenMontage input attachment must belong to the same channel as the Job",
    );
  }

  const id = `om_ag_${randomLikeId()}`;
  const token = randomBytes(32).toString("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO openmontage_artifact_grant (
      id, workspace_id, job_id, attachment_id, operation,
      token_hash, expires_at, created_at
    ) VALUES (?, ?, ?, ?, 'READ', ?, ?, ?)`,
  ).run(id, workspaceId, jobId, attachmentId, hashToken(token), expiresAt, createdAt);

  return {
    token,
    grant: {
      id,
      workspaceId,
      jobId,
      attachmentId,
      operation: "READ",
      expiresAt,
      createdAt,
    },
  };
}

export function consumeOpenMontageArtifactReadGrantSync(input: {
  grantId: string;
  token: string;
  now?: string;
}): { grant: OpenMontageArtifactReadGrantRecord; attachment: StoredAttachmentRecord } {
  const grantId = requiredIdentifier(input.grantId, "grantId");
  const token = requiredIdentifier(input.token, "token");
  const now = parseTimestamp(input.now ?? new Date().toISOString(), "now");
  const db = getDatabase();

  return withTransaction(db, () => {
    const row = db.prepare(
      `SELECT id, workspace_id AS "workspaceId", job_id AS "jobId",
              attachment_id AS "attachmentId", operation,
              token_hash AS "tokenHash", expires_at AS "expiresAt",
              consumed_at AS "consumedAt", created_at AS "createdAt"
         FROM openmontage_artifact_grant
        WHERE id = ?`,
    ).get(grantId) as Record<string, unknown> | undefined;
    if (!row || typeof row.tokenHash !== "string" || !tokenMatches(row.tokenHash, token)) {
      throw new OpenMontageArtifactGrantError("OpenMontage artifact grant is invalid");
    }
    const grant = mapReadGrant(row);
    if (grant.consumedAt) {
      throw new OpenMontageArtifactGrantError("OpenMontage artifact grant was already consumed");
    }
    if (parseTimestamp(grant.expiresAt, "expiresAt").getTime() < now.getTime()) {
      throw new OpenMontageArtifactGrantError("OpenMontage artifact grant has expired");
    }

    const updated = db.prepare(
      `UPDATE openmontage_artifact_grant
          SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL`,
    ).run(now.toISOString(), grantId);
    if (updated.changes !== 1) {
      throw new OpenMontageArtifactGrantError("OpenMontage artifact grant was already consumed");
    }
    const attachment = readStoredAttachmentSync(grant.workspaceId, grant.attachmentId);
    if (!attachment) {
      throw new OpenMontageArtifactGrantError("OpenMontage input attachment is no longer available");
    }
    return {
      grant: { ...grant, consumedAt: now.toISOString() },
      attachment,
    };
  });
}

export function issueOpenMontageArtifactWriteGrantSync(input: {
  workspaceId: string;
  jobId: string;
  role: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  ttlSeconds?: number;
  now?: string;
}): { grant: OpenMontageArtifactWriteGrantRecord; token: string } {
  const workspaceId = requiredIdentifier(input.workspaceId, "workspaceId");
  const jobId = requiredIdentifier(input.jobId, "jobId");
  const role = validateOutputRole(input.role);
  const fileName = validateOutputFileName(input.fileName);
  const mediaType = validateOutputMediaType(input.mediaType);
  const sizeBytes = validateOutputSize(input.sizeBytes);
  const sha256 = validateSha256(input.sha256);
  const now = parseTimestamp(input.now ?? new Date().toISOString(), "now");
  const ttlSeconds = validateTtl(input.ttlSeconds);
  const db = getDatabase();

  const link = db.prepare(
    `SELECT 1
       FROM openmontage_job_link
      WHERE job_id = ? AND workspace_id = ?`,
  ).get(jobId, workspaceId);
  if (!link) {
    throw new OpenMontageArtifactGrantError("OpenMontage Job is not available");
  }

  const id = `om_ag_${randomLikeId()}`;
  const token = randomBytes(32).toString("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO openmontage_artifact_grant (
      id, workspace_id, job_id, attachment_id, operation,
      artifact_role, file_name, media_type, size_bytes, sha256,
      token_hash, expires_at, created_at
    ) VALUES (?, ?, ?, NULL, 'WRITE', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    jobId,
    role,
    fileName,
    mediaType,
    sizeBytes,
    sha256,
    hashToken(token),
    expiresAt,
    createdAt,
  );

  return {
    token,
    grant: {
      id,
      workspaceId,
      jobId,
      operation: "WRITE",
      role,
      fileName,
      mediaType,
      sizeBytes,
      sha256,
      expiresAt,
      createdAt,
    },
  };
}

export function consumeOpenMontageArtifactWriteGrantSync(input: {
  grantId: string;
  token: string;
  now?: string;
}): OpenMontageArtifactWriteGrantRecord {
  const grantId = requiredIdentifier(input.grantId, "grantId");
  const token = requiredIdentifier(input.token, "token");
  const now = parseTimestamp(input.now ?? new Date().toISOString(), "now");
  const db = getDatabase();

  return withTransaction(db, () => {
    const row = readGrantRow(grantId);
    if (!row || typeof row.tokenHash !== "string" || !tokenMatches(row.tokenHash, token)) {
      throw new OpenMontageArtifactGrantError("OpenMontage artifact grant is invalid");
    }
    const grant = mapWriteGrant(row);
    ensureGrantCanBeConsumed(grant, now);
    consumeGrant(grantId, now);
    return { ...grant, consumedAt: now.toISOString() };
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function mapReadGrant(row: Record<string, unknown>): OpenMontageArtifactReadGrantRecord {
  if (
    typeof row.id !== "string"
    || typeof row.workspaceId !== "string"
    || typeof row.jobId !== "string"
    || typeof row.attachmentId !== "string"
    || row.operation !== "READ"
    || typeof row.expiresAt !== "string"
    || typeof row.createdAt !== "string"
  ) {
    throw new OpenMontageArtifactGrantError("Persisted OpenMontage artifact grant is invalid");
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    attachmentId: row.attachmentId,
    operation: "READ",
    expiresAt: row.expiresAt,
    consumedAt: typeof row.consumedAt === "string" ? row.consumedAt : undefined,
    createdAt: row.createdAt,
  };
}

function mapWriteGrant(row: Record<string, unknown>): OpenMontageArtifactWriteGrantRecord {
  if (
    typeof row.id !== "string"
    || typeof row.workspaceId !== "string"
    || typeof row.jobId !== "string"
    || row.operation !== "WRITE"
    || typeof row.artifactRole !== "string"
    || typeof row.fileName !== "string"
    || typeof row.mediaType !== "string"
    || (typeof row.sizeBytes !== "number" && typeof row.sizeBytes !== "bigint")
    || typeof row.sha256 !== "string"
    || typeof row.expiresAt !== "string"
    || typeof row.createdAt !== "string"
  ) {
    throw new OpenMontageArtifactGrantError("Persisted OpenMontage artifact grant is invalid");
  }
  const sizeBytes = Number(row.sizeBytes);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    operation: "WRITE",
    role: validateOutputRole(row.artifactRole),
    fileName: validateOutputFileName(row.fileName),
    mediaType: validateOutputMediaType(row.mediaType),
    sizeBytes: validateOutputSize(sizeBytes),
    sha256: validateSha256(row.sha256),
    expiresAt: row.expiresAt,
    consumedAt: typeof row.consumedAt === "string" ? row.consumedAt : undefined,
    createdAt: row.createdAt,
  };
}

function readGrantRow(grantId: string): Record<string, unknown> | undefined {
  return getDatabase().prepare(
    `SELECT id, workspace_id AS "workspaceId", job_id AS "jobId",
            attachment_id AS "attachmentId", operation,
            artifact_role AS "artifactRole", file_name AS "fileName",
            media_type AS "mediaType", size_bytes AS "sizeBytes", sha256,
            token_hash AS "tokenHash", expires_at AS "expiresAt",
            consumed_at AS "consumedAt", created_at AS "createdAt"
       FROM openmontage_artifact_grant
      WHERE id = ?`,
  ).get(grantId) as Record<string, unknown> | undefined;
}

function ensureGrantCanBeConsumed(
  grant: OpenMontageArtifactReadGrantRecord | OpenMontageArtifactWriteGrantRecord,
  now: Date,
): void {
  if (grant.consumedAt) {
    throw new OpenMontageArtifactGrantError("OpenMontage artifact grant was already consumed");
  }
  if (parseTimestamp(grant.expiresAt, "expiresAt").getTime() < now.getTime()) {
    throw new OpenMontageArtifactGrantError("OpenMontage artifact grant has expired");
  }
}

function consumeGrant(grantId: string, now: Date): void {
  const updated = getDatabase().prepare(
    `UPDATE openmontage_artifact_grant
        SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL`,
  ).run(now.toISOString(), grantId);
  if (updated.changes !== 1) {
    throw new OpenMontageArtifactGrantError("OpenMontage artifact grant was already consumed");
  }
}

function validateTtl(value: number | undefined): number {
  const ttlSeconds = value ?? DEFAULT_GRANT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_GRANT_TTL_SECONDS) {
    throw new OpenMontageArtifactGrantError(
      `ttlSeconds must be an integer between 1 and ${MAX_GRANT_TTL_SECONDS}`,
    );
  }
  return ttlSeconds;
}

function validateOutputRole(value: string): string {
  const role = value.trim();
  if (!OUTPUT_ROLES.has(role)) {
    throw new OpenMontageArtifactGrantError("role is not an allowed OpenMontage artifact role");
  }
  return role;
}

function validateOutputFileName(value: string): string {
  const fileName = value.trim();
  if (
    !fileName
    || fileName.length > 255
    || fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw new OpenMontageArtifactGrantError("fileName must be a safe base name");
  }
  return fileName;
}

function validateOutputMediaType(value: string): string {
  const mediaType = value.trim().toLowerCase();
  if (!OUTPUT_MEDIA_TYPES.has(mediaType)) {
    throw new OpenMontageArtifactGrantError("mediaType is not allowed for OpenMontage output");
  }
  return mediaType;
}

function validateOutputSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_SIZE_BYTES) {
    throw new OpenMontageArtifactGrantError(
      `sizeBytes must be an integer between 1 and ${MAX_OUTPUT_SIZE_BYTES}`,
    );
  }
  return value;
}

function validateSha256(value: string): string {
  const sha256 = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new OpenMontageArtifactGrantError("sha256 must be a lowercase SHA-256 digest");
  }
  return sha256;
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new OpenMontageArtifactGrantError(`${name} must be between 1 and 256 characters`);
  }
  return normalized;
}

function parseTimestamp(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OpenMontageArtifactGrantError(`${name} must be an ISO timestamp`);
  }
  return parsed;
}
