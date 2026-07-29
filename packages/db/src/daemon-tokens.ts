import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { DaemonApiTokenPurpose, DaemonApiTokenRecord } from "./types.ts";

export interface CreateDaemonApiTokenInput {
  workspaceId?: string;
  label: string;
  createdBy: string;
}

export function createDaemonApiTokenSync(input: CreateDaemonApiTokenInput): DaemonApiTokenRecord & { token: string } {
  return createDaemonApiTokenWithPurposeSync(input, "general");
}

/** Only managed-runtime orchestration may issue a node bootstrap credential. */
export function createManagedDaemonBootstrapTokenSync(
  input: CreateDaemonApiTokenInput,
): DaemonApiTokenRecord & { token: string } {
  return createDaemonApiTokenWithPurposeSync(input, "managed_node_bootstrap");
}

function createDaemonApiTokenWithPurposeSync(
  input: CreateDaemonApiTokenInput,
  purpose: DaemonApiTokenPurpose,
): DaemonApiTokenRecord & { token: string } {
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const token = `adt_${randomBytes(24).toString("hex")}`;
  const id = `daemon-token-${randomLikeId()}`;
  const tokenHash = hashDaemonToken(token);

  db.prepare(
    `INSERT INTO daemon_api_token (
      id,
      workspace_id,
      daemon_connection_id,
      label,
      token_hash,
      purpose,
      status,
      created_by,
      created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, workspaceId, input.label.trim(), tokenHash, purpose, input.createdBy.trim(), now);

  const record = readDaemonApiTokenSync(id);
  if (!record) {
    throw new Error(`Daemon API token "${id}" could not be read back.`);
  }

  return {
    ...record,
    token,
  };
}

export function listDaemonApiTokensSync(workspaceId = DEFAULT_WORKSPACE_ID): DaemonApiTokenRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        label,
        token_hash AS tokenHash,
        purpose,
        status,
        created_by AS createdBy,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        revoked_at AS revokedAt
      FROM daemon_api_token
      WHERE workspace_id = ?
      ORDER BY created_at DESC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapDaemonApiTokenRecord(row))
    .filter((row): row is DaemonApiTokenRecord => row !== null);
}

export function readDaemonApiTokenSync(id: string): DaemonApiTokenRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        label,
        token_hash AS tokenHash,
        purpose,
        status,
        created_by AS createdBy,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        revoked_at AS revokedAt
      FROM daemon_api_token
      WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  return row ? mapDaemonApiTokenRecord(row) : null;
}

export function validateDaemonApiTokenSync(token: string): DaemonApiTokenRecord | null {
  if (!token.startsWith("adt_")) {
    return null;
  }

  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        label,
        token_hash AS tokenHash,
        purpose,
        status,
        created_by AS createdBy,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        revoked_at AS revokedAt
      FROM daemon_api_token
      WHERE token_hash = ?`,
    )
    .get(hashDaemonToken(token)) as Record<string, unknown> | undefined;

  const record = row ? mapDaemonApiTokenRecord(row) : null;
  if (!record || record.status !== "active") {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE daemon_api_token
     SET last_used_at = ?
     WHERE id = ?`,
  ).run(now, record.id);

  return {
    ...record,
    lastUsedAt: now,
  };
}

export function revokeDaemonApiTokenSync(id: string): DaemonApiTokenRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE daemon_api_token
     SET status = 'revoked',
         revoked_at = ?,
         last_used_at = COALESCE(last_used_at, ?)
     WHERE id = ?`,
  ).run(now, now, id);

  const record = readDaemonApiTokenSync(id);
  if (!record) {
    throw new Error(`Daemon API token "${id}" does not exist.`);
  }
  return record;
}

function hashDaemonToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapDaemonApiTokenRecord(value: Record<string, unknown>): DaemonApiTokenRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.label !== "string" ||
    typeof value.tokenHash !== "string" ||
    (value.purpose !== "general" && value.purpose !== "managed_node_bootstrap") ||
    (value.status !== "active" && value.status !== "revoked") ||
    typeof value.createdBy !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    daemonConnectionId: typeof value.daemonConnectionId === "string" ? value.daemonConnectionId : undefined,
    label: value.label,
    tokenHash: value.tokenHash,
    purpose: value.purpose,
    status: value.status,
    createdBy: value.createdBy,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
    createdAt: value.createdAt,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}
