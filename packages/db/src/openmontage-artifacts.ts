import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { readStoredAttachmentSync, type StoredAttachmentRecord } from "./attachments.ts";

const DEFAULT_GRANT_TTL_SECONDS = 300;
const MAX_GRANT_TTL_SECONDS = 900;

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
    const grant = mapGrant(row);
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

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function mapGrant(row: Record<string, unknown>): OpenMontageArtifactReadGrantRecord {
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
