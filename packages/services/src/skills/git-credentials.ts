import { createHash } from "node:crypto";
import {
  listWorkspaceGitCredentialsSync as listCredentialsDbSync,
  readWorkspaceGitCredentialByHostSync,
  readWorkspaceGitCredentialSync,
  revokeWorkspaceGitCredentialSync as revokeCredentialDbSync,
  upsertWorkspaceGitCredentialSync,
  type WorkspaceGitCredentialRecord,
} from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { decryptServiceSecret, encryptServiceSecret } from "../mcp-center/security.ts";

export type GitCredentialType = "token" | "ssh_key";

export interface GitCredentialSafeView {
  id: string;
  host: string;
  credentialType: GitCredentialType;
  referenceName: string;
  status: "active" | "revoked";
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeHost(host: string): string {
  return host.trim().toLocaleLowerCase("en-US").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Stores (or rotates) the workspace's private Git credential reference for a
 * host. The plaintext is AES-256-GCM encrypted at rest and never returned to
 * the UI; only a sha256 fingerprint is persisted alongside for rotation/leak
 * detection.
 */
export function setWorkspaceGitCredentialSync(input: {
  workspaceId: string;
  host: string;
  credentialType: GitCredentialType;
  secret: string;
  referenceName?: string;
  actorUserId?: string;
  actorDisplayName?: string;
  rotate?: boolean;
}): GitCredentialSafeView {
  const host = normalizeHost(input.host);
  if (!host || (host !== "github.com" && host !== "gitlab.com")) {
    throw new Error("Git 凭证仅支持 github.com 或 gitlab.com。");
  }
  const secret = input.secret.trim();
  if (!secret) {
    throw new Error("Git 凭证不能为空。");
  }
  const record = upsertWorkspaceGitCredentialSync({
    workspaceId: input.workspaceId,
    host,
    credentialType: input.credentialType,
    referenceName: input.referenceName?.trim() || `Private Git · ${host}`,
    encryptedSecret: encryptServiceSecret(secret),
    fingerprint: fingerprintSecret(secret),
    createdByUserId: input.actorUserId,
    rotated: input.rotate === true,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: input.rotate === true ? "Git credential rotated" : "Git credential stored",
    note: `${input.actorDisplayName ?? input.actorUserId ?? "Admin"} ${input.rotate === true ? "rotated" : "stored"} the private Git credential for ${host}.`,
    code: input.rotate === true ? "workspace.git_credential_rotated" : "workspace.git_credential_stored",
    data: {
      actorType: "session_user",
      resourceType: "workspace_git_credential",
      resourceId: record.id,
      host,
    },
  });
  return toSafeView(record);
}

/** Lists credential references — never the encrypted secret. */
export function listWorkspaceGitCredentialsSync(workspaceId: string): GitCredentialSafeView[] {
  return listCredentialsDbSync(workspaceId).map(toSafeView);
}

/**
 * Resolves the decrypted secret for a host (used by private-repo skill imports).
 * Records an audit event on every use. Returns null when no active credential
 * is configured for the host.
 */
export function resolveWorkspaceGitCredentialSecretSync(input: {
  workspaceId: string;
  host: string;
  actorUserId?: string;
  actorDisplayName?: string;
  /** Skip the per-use audit record (import fetches resolve per call; the entry audits once). */
  silent?: boolean;
}): string | null {
  const host = normalizeHost(input.host);
  const credential = readWorkspaceGitCredentialByHostSync(host, input.workspaceId);
  if (!credential) {
    return null;
  }
  let secret: string;
  try {
    secret = decryptServiceSecret(credential.encryptedSecret);
  } catch {
    return null;
  }
  if (!input.silent) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Git credential used",
      note: `Private Git credential for ${host} was resolved${input.actorDisplayName ? ` by ${input.actorDisplayName}` : ""}.`,
      code: "workspace.git_credential_used",
      data: {
        resourceType: "workspace_git_credential",
        resourceId: credential.id,
        host,
        actorUserId: input.actorUserId,
      },
    });
  }
  return secret;
}

/**
 * Returns the Authorization header for a private-repo API fetch, or {} when no
 * active credential is configured for the host. Silent: import fetches resolve
 * per request; the import entry records a single audit event instead.
 */
export function gitAuthHeadersSync(workspaceId: string, host: string): Record<string, string> {
  const token = resolveWorkspaceGitCredentialSecretSync({ workspaceId, host, silent: true });
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function revokeWorkspaceGitCredentialSync(input: {
  workspaceId: string;
  credentialId: string;
  actorUserId?: string;
  actorDisplayName?: string;
}): boolean {
  const credential = readWorkspaceGitCredentialSync(input.credentialId.trim(), input.workspaceId);
  if (!credential) {
    throw new Error("Git 凭证不存在。");
  }
  const revoked = revokeCredentialDbSync(input.credentialId.trim(), input.workspaceId);
  if (revoked) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Git credential revoked",
      note: `Private Git credential for ${credential.host} was revoked${input.actorDisplayName ? ` by ${input.actorDisplayName}` : ""}.`,
      code: "workspace.git_credential_revoked",
      data: {
        resourceType: "workspace_git_credential",
        resourceId: credential.id,
        host: credential.host,
        actorUserId: input.actorUserId,
      },
    });
  }
  return revoked;
}

export function isGitCredentialConfiguredSync(workspaceId: string, host: string): boolean {
  return readWorkspaceGitCredentialByHostSync(normalizeHost(host), workspaceId) !== null;
}

function toSafeView(record: WorkspaceGitCredentialRecord): GitCredentialSafeView {
  return {
    id: record.id,
    host: record.host,
    credentialType: record.credentialType,
    referenceName: record.referenceName,
    status: record.status,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
  };
}
