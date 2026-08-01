import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type { ContentBlobRecord } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface UpsertContentBlobInput {
  workspaceId?: string;
  sha256: string;
  storageProvider: string;
  storageBucket?: string;
  storageRegion?: string;
  storageEndpoint?: string;
  storageKey: string;
  sizeBytes: number;
  mediaType?: string;
  createdAt?: string;
}

/* ------------------------------------------------------------------ */
/* Content blobs (content-addressed index of object-storage payloads)  */
/* ------------------------------------------------------------------ */

const CONTENT_BLOB_COLUMNS = `SELECT
  sha256,
  workspace_id AS workspaceId,
  storage_provider AS storageProvider,
  storage_bucket AS storageBucket,
  storage_region AS storageRegion,
  storage_endpoint AS storageEndpoint,
  storage_key AS storageKey,
  size_bytes AS sizeBytes,
  media_type AS mediaType,
  created_at AS createdAt`;

/**
 * Idempotent insert: a (workspace_id, sha256) pair maps to exactly one blob.
 * Re-inserting the same digest is a no-op (content addressing + dedup).
 */
export function upsertContentBlobSync(input: UpsertContentBlobInput): ContentBlobRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sha256 = input.sha256.trim().toLowerCase();
  if (!sha256) {
    throw new Error("Content blob sha256 is required.");
  }
  if (!input.storageKey?.trim()) {
    throw new Error("Content blob storage key is required.");
  }
  const now = input.createdAt ?? new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO content_blob (
        sha256, workspace_id, storage_provider, storage_bucket, storage_region, storage_endpoint,
        storage_key, size_bytes, media_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, sha256) DO NOTHING`,
    ).run(
      sha256,
      workspaceId,
      input.storageProvider,
      input.storageBucket ?? null,
      input.storageRegion ?? null,
      input.storageEndpoint ?? null,
      input.storageKey.trim(),
      input.sizeBytes,
      input.mediaType ?? "application/octet-stream",
      now,
    );
  });
  const record = readContentBlobSync(sha256, workspaceId);
  if (!record) {
    throw new Error("Failed to persist content blob.");
  }
  return record;
}

export function readContentBlobSync(sha256: string, workspaceId = DEFAULT_WORKSPACE_ID): ContentBlobRecord | null {
  const row = getDatabase().prepare(
    `${CONTENT_BLOB_COLUMNS} FROM content_blob WHERE workspace_id = ? AND sha256 = ?`,
  ).get(workspaceId, sha256.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? mapContentBlobRecord(row) : null;
}

export function listContentBlobsSync(options: { workspaceId?: string; limit?: number } = {}): ContentBlobRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
  const rows = getDatabase().prepare(
    `${CONTENT_BLOB_COLUMNS} FROM content_blob WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapContentBlobRecord).filter((r): r is ContentBlobRecord => r !== null);
}

export interface ReferencedBlobDigests {
  skillArtifactFileDigests?: string[];
  workspaceRevisionDigests?: string[];
  employeeArtifactDigests?: string[];
}

/**
 * Returns blob digests present in storage but not referenced by any artifact,
 * workspace revision, or published employee artifact. Used by the delayed
 * orphan-blob reclamation sweep (P2). Excludes blobs created within the
 * `retainRecentSeconds` window to avoid collecting in-flight uploads.
 */
export function listOrphanContentBlobsSync(
  workspaceId: string,
  referenced: ReferencedBlobDigests,
  options: { retainRecentSeconds?: number; now?: string; limit?: number } = {},
): ContentBlobRecord[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
  const referencedSet = new Set<string>([
    ...(referenced.skillArtifactFileDigests ?? []),
    ...(referenced.workspaceRevisionDigests ?? []),
    ...(referenced.employeeArtifactDigests ?? []),
  ].map((value) => value.trim().toLowerCase()));

  const cutoff = options.retainRecentSeconds
    ? new Date(Date.parse(options.now ?? new Date().toISOString()) - options.retainRecentSeconds * 1000).toISOString()
    : null;

  const rows = db.prepare(
    `${CONTENT_BLOB_COLUMNS} FROM content_blob WHERE workspace_id = ?
     ${cutoff ? "AND created_at < ? " : ""}ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...(cutoff ? [workspaceId, cutoff] : [workspaceId])) as Array<Record<string, unknown>>;

  return rows
    .map(mapContentBlobRecord)
    .filter((r): r is ContentBlobRecord => r !== null)
    .filter((blob) => !referencedSet.has(blob.sha256));
}

export function deleteContentBlobSync(sha256: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const result = getDatabase().prepare(
    `DELETE FROM content_blob WHERE workspace_id = ? AND sha256 = ?`,
  ).run(workspaceId, sha256.trim().toLowerCase());
  return result.changes > 0;
}

/** Stable content-addressed object key shared with the storage client. */
export function buildContentBlobStorageKey(workspaceId: string, sha256: string): string {
  const normalized = sha256.trim().toLowerCase();
  return [
    "workspaces",
    workspaceId,
    "content-blobs",
    normalized.slice(0, 2) || "00",
    normalized,
  ].join("/");
}

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

function mapContentBlobRecord(value: Record<string, unknown>): ContentBlobRecord | null {
  if (
    typeof value.sha256 !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.storageProvider !== "string" ||
    typeof value.storageKey !== "string" ||
    typeof value.sizeBytes !== "number" ||
    typeof value.mediaType !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    sha256: value.sha256,
    workspaceId: value.workspaceId,
    storageProvider: value.storageProvider,
    storageBucket: readOptionalString(value.storageBucket),
    storageRegion: readOptionalString(value.storageRegion),
    storageEndpoint: readOptionalString(value.storageEndpoint),
    storageKey: value.storageKey,
    sizeBytes: value.sizeBytes,
    mediaType: value.mediaType,
    createdAt: value.createdAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Re-exported for callers that compose id generation with blob persistence.
export const internalRandomLikeId = randomLikeId;
