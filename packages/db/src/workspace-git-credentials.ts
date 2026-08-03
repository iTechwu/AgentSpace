import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type { WorkspaceGitCredentialRecord } from "./types.ts";

const CREDENTIAL_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, host, credential_type AS credentialType,
  reference_name AS referenceName, encrypted_secret AS encryptedSecret,
  fingerprint, status, created_by_user_id AS createdByUserId,
  created_at AS createdAt, updated_at AS updatedAt,
  rotated_at AS rotatedAt, revoked_at AS revokedAt`;

export interface UpsertWorkspaceGitCredentialInput {
  workspaceId?: string;
  host: string;
  credentialType: "token" | "ssh_key";
  referenceName: string;
  encryptedSecret: string;
  fingerprint: string;
  createdByUserId?: string;
  rotated?: boolean;
}

export function upsertWorkspaceGitCredentialSync(
  input: UpsertWorkspaceGitCredentialInput,
): WorkspaceGitCredentialRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const host = input.host.trim().toLocaleLowerCase("en-US");
  const now = new Date().toISOString();
  const existing = readWorkspaceGitCredentialByHostSync(host, workspaceId);
  if (existing) {
    db.prepare(
      `UPDATE workspace_git_credential
       SET credential_type = ?, reference_name = ?, encrypted_secret = ?, fingerprint = ?,
           status = 'active', updated_at = ?, rotated_at = COALESCE(?, rotated_at), revoked_at = NULL
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.credentialType,
      input.referenceName.trim(),
      input.encryptedSecret,
      input.fingerprint,
      now,
      input.rotated === true ? now : null,
      existing.id,
      workspaceId,
    );
    return readWorkspaceGitCredentialSync(existing.id, workspaceId)!;
  }
  const id = `wgc-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO workspace_git_credential (
      id, workspace_id, host, credential_type, reference_name, encrypted_secret,
      fingerprint, status, created_by_user_id, created_at, updated_at, rotated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    workspaceId,
    host,
    input.credentialType,
    input.referenceName.trim(),
    input.encryptedSecret,
    input.fingerprint,
    input.createdByUserId?.trim() || null,
    now,
    now,
  );
  return readWorkspaceGitCredentialSync(id, workspaceId)!;
}

export function readWorkspaceGitCredentialSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceGitCredentialRecord | null {
  const row = getDatabase().prepare(
    `${CREDENTIAL_COLUMNS} FROM workspace_git_credential WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapGitCredentialRecord(row) : null;
}

export function readWorkspaceGitCredentialByHostSync(
  host: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceGitCredentialRecord | null {
  const row = getDatabase().prepare(
    `${CREDENTIAL_COLUMNS} FROM workspace_git_credential
     WHERE workspace_id = ? AND host = ? AND status = 'active'`,
  ).get(workspaceId, host.trim().toLocaleLowerCase("en-US")) as Record<string, unknown> | undefined;
  return row ? mapGitCredentialRecord(row) : null;
}

export function listWorkspaceGitCredentialsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceGitCredentialRecord[] {
  const rows = getDatabase().prepare(
    `${CREDENTIAL_COLUMNS} FROM workspace_git_credential WHERE workspace_id = ? ORDER BY host ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapGitCredentialRecord).filter((r): r is WorkspaceGitCredentialRecord => r !== null);
}

export function revokeWorkspaceGitCredentialSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE workspace_git_credential SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'active'`,
  ).run(now, now, id, workspaceId);
  return result.changes > 0;
}

function mapGitCredentialRecord(value: Record<string, unknown>): WorkspaceGitCredentialRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.host !== "string" ||
    (value.credentialType !== "token" && value.credentialType !== "ssh_key") ||
    typeof value.referenceName !== "string" ||
    typeof value.encryptedSecret !== "string" ||
    typeof value.fingerprint !== "string" ||
    (value.status !== "active" && value.status !== "revoked") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    host: value.host,
    credentialType: value.credentialType,
    referenceName: value.referenceName,
    encryptedSecret: value.encryptedSecret,
    fingerprint: value.fingerprint,
    status: value.status,
    createdByUserId: typeof value.createdByUserId === "string" ? value.createdByUserId : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    rotatedAt: typeof value.rotatedAt === "string" ? value.rotatedAt : undefined,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}
