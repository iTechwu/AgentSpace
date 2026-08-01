import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  SkillArtifactFileRecord,
  SkillArtifactRecord,
  SkillArtifactSource,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface SkillArtifactFileInput {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  mode: string;
  isText: boolean;
}

export interface CreateSkillArtifactInput {
  workspaceId?: string;
  digest: string;
  skillId?: string;
  name: string;
  version?: string;
  manifestVersion?: number;
  manifestJson: string;
  sourceType?: string;
  sourceUrl?: string;
  provenanceJson?: string;
  fileCount: number;
  totalSizeBytes: number;
  legacyIncomplete?: boolean;
  files: SkillArtifactFileInput[];
  createdAt?: string;
}

/* ------------------------------------------------------------------ */
/* Column selectors                                                    */
/* ------------------------------------------------------------------ */

const SKILL_ARTIFACT_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, digest, skill_id AS skillId, name, version,
  manifest_version AS manifestVersion, manifest_json AS manifestJson,
  source_type AS sourceType, source_url AS sourceUrl,
  provenance_json AS provenanceJson, file_count AS fileCount,
  total_size_bytes AS totalSizeBytes, legacy_incomplete AS legacyIncomplete,
  created_at AS createdAt`;

const SKILL_ARTIFACT_FILE_COLUMNS = `SELECT
  id, artifact_id AS artifactId, workspace_id AS workspaceId, path, sha256,
  size_bytes AS sizeBytes, media_type AS mediaType, mode, is_text AS isText,
  created_at AS createdAt`;

/* ------------------------------------------------------------------ */
/* Create (idempotent by digest)                                       */
/* ------------------------------------------------------------------ */

/**
 * Persist an immutable skill artifact. Content-addressed: re-inserting the same
 * (workspace_id, digest) is a no-op and returns the existing record. Files are
 * only inserted when the artifact row is newly created.
 */
export function createSkillArtifactSync(input: CreateSkillArtifactInput): SkillArtifactRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const digest = input.digest.trim().toLowerCase();
  if (!digest) {
    throw new Error("Skill artifact digest is required.");
  }
  if (!input.name?.trim()) {
    throw new Error("Skill artifact name is required.");
  }

  const existing = readSkillArtifactByDigestSync(digest, workspaceId);
  if (existing) {
    // If a skill_id is being associated and the stored row lacks one, attach it.
    if (input.skillId && !existing.skillId) {
      db.prepare(
        `UPDATE skill_artifact SET skill_id = ? WHERE id = ? AND workspace_id = ?`,
      ).run(input.skillId, existing.id, workspaceId);
    }
    return readSkillArtifactByDigestSync(digest, workspaceId) ?? existing;
  }

  const id = `skill-art-${randomLikeId()}`;
  const now = input.createdAt ?? new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO skill_artifact (
        id, workspace_id, digest, skill_id, name, version, manifest_version, manifest_json,
        source_type, source_url, provenance_json, file_count, total_size_bytes,
        legacy_incomplete, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      digest,
      input.skillId ?? null,
      input.name.trim(),
      input.version?.trim() ?? "",
      input.manifestVersion ?? 1,
      input.manifestJson,
      input.sourceType ?? "manual",
      input.sourceUrl?.trim() || null,
      input.provenanceJson ?? "{}",
      input.fileCount,
      input.totalSizeBytes,
      input.legacyIncomplete ? 1 : 0,
      now,
    );

    for (const file of input.files) {
      const fileId = `skill-art-file-${randomLikeId()}`;
      db.prepare(
        `INSERT INTO skill_artifact_file (
          id, artifact_id, workspace_id, path, sha256, size_bytes, media_type, mode, is_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fileId,
        id,
        workspaceId,
        file.path,
        file.sha256.trim().toLowerCase(),
        file.sizeBytes,
        file.mediaType,
        file.mode,
        file.isText ? 1 : 0,
        now,
      );
    }
  });

  const record = readSkillArtifactSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to persist skill artifact.");
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function readSkillArtifactSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): SkillArtifactRecord | null {
  const row = getDatabase().prepare(
    `${SKILL_ARTIFACT_COLUMNS} FROM skill_artifact WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapSkillArtifactRecord(row) : null;
}

export function readSkillArtifactByDigestSync(
  digest: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillArtifactRecord | null {
  const row = getDatabase().prepare(
    `${SKILL_ARTIFACT_COLUMNS} FROM skill_artifact WHERE workspace_id = ? AND digest = ?`,
  ).get(workspaceId, digest.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? mapSkillArtifactRecord(row) : null;
}

export function listSkillArtifactsForSkillSync(
  skillId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): SkillArtifactRecord[] {
  const rows = getDatabase().prepare(
    `${SKILL_ARTIFACT_COLUMNS} FROM skill_artifact WHERE workspace_id = ? AND skill_id = ? ORDER BY created_at DESC`,
  ).all(workspaceId, skillId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillArtifactRecord).filter((r): r is SkillArtifactRecord => r !== null);
}

export function listSkillArtifactsSync(options: { workspaceId?: string; limit?: number } = {}): SkillArtifactRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const rows = getDatabase().prepare(
    `${SKILL_ARTIFACT_COLUMNS} FROM skill_artifact WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillArtifactRecord).filter((r): r is SkillArtifactRecord => r !== null);
}

export function readSkillArtifactFilesSync(artifactId: string): SkillArtifactFileRecord[] {
  const rows = getDatabase().prepare(
    `${SKILL_ARTIFACT_FILE_COLUMNS} FROM skill_artifact_file WHERE artifact_id = ? ORDER BY path ASC`,
  ).all(artifactId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillArtifactFileRecord).filter((r): r is SkillArtifactFileRecord => r !== null);
}

export function listSkillArtifactFileDigestsSync(workspaceId = DEFAULT_WORKSPACE_ID): string[] {
  const rows = getDatabase().prepare(
    `SELECT DISTINCT sha256 FROM skill_artifact_file WHERE workspace_id = ?`,
  ).all(workspaceId) as Array<{ sha256: string }>;
  return rows.map((row) => row.sha256).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Active digest wiring (skill row + agent_skill assignment)           */
/* ------------------------------------------------------------------ */

/** Pins the active artifact digest on the skill row. Idempotent. */
export function setActiveArtifactDigestForSkillSync(input: {
  skillId: string;
  digest?: string;
  workspaceId?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = db.prepare(
    `UPDATE skill SET active_artifact_digest = ? WHERE id = ? AND workspace_id = ?`,
  ).run(input.digest?.trim().toLowerCase() || null, input.skillId, workspaceId);
  return result.changes > 0;
}

export function readActiveArtifactDigestForSkillSync(
  skillId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): string | undefined {
  const row = getDatabase().prepare(
    `SELECT active_artifact_digest AS digest FROM skill WHERE id = ? AND workspace_id = ?`,
  ).get(skillId, workspaceId) as { digest?: string } | undefined;
  const digest = row?.digest;
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

function agentSkillTableHasDigestColumn(db: ReturnType<typeof getDatabase>): boolean {
  const row = db.prepare(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agent_skill' AND column_name = 'skill_artifact_digest'
     LIMIT 1`,
  ).get() as { column_name?: string } | undefined;
  return row?.column_name === "skill_artifact_digest";
}

/** Pins the artifact digest on an employee↔skill assignment (agent_skill). */
export function setAssignmentArtifactDigestSync(input: {
  employeeName: string;
  skillId: string;
  digest?: string;
  workspaceId?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!agentSkillTableHasDigestColumn(db)) {
    return false;
  }
  const result = db.prepare(
    `UPDATE agent_skill
       SET skill_artifact_digest = ?
     WHERE workspace_id = ? AND employee_name = ? AND skill_id = ?`,
  ).run(input.digest?.trim().toLowerCase() || null, workspaceId, input.employeeName, input.skillId);
  return result.changes > 0;
}

export function readAssignmentArtifactDigestSync(input: {
  employeeName: string;
  skillId: string;
  workspaceId?: string;
}): string | undefined {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!agentSkillTableHasDigestColumn(db)) {
    return undefined;
  }
  const row = db.prepare(
    `SELECT skill_artifact_digest AS digest FROM agent_skill
      WHERE workspace_id = ? AND employee_name = ? AND skill_id = ?`,
  ).get(workspaceId, input.employeeName, input.skillId) as { digest?: string } | undefined;
  const digest = row?.digest;
  return typeof digest === "string" && digest.length > 0 ? digest : undefined;
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function mapSkillArtifactRecord(value: Record<string, unknown>): SkillArtifactRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.digest !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.manifestVersion !== "number" ||
    typeof value.manifestJson !== "string" ||
    typeof value.sourceType !== "string" ||
    typeof value.provenanceJson !== "string" ||
    typeof value.fileCount !== "number" ||
    typeof value.totalSizeBytes !== "number" ||
    typeof value.legacyIncomplete !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    digest: value.digest,
    skillId: readOptionalString(value.skillId),
    name: value.name,
    version: value.version,
    manifestVersion: value.manifestVersion,
    manifestJson: value.manifestJson,
    sourceType: value.sourceType as SkillArtifactSource,
    sourceUrl: readOptionalString(value.sourceUrl),
    provenanceJson: value.provenanceJson,
    fileCount: value.fileCount,
    totalSizeBytes: value.totalSizeBytes,
    legacyIncomplete: value.legacyIncomplete === 1,
    createdAt: value.createdAt,
  };
}

function mapSkillArtifactFileRecord(value: Record<string, unknown>): SkillArtifactFileRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.artifactId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.sizeBytes !== "number" ||
    typeof value.mediaType !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.isText !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    artifactId: value.artifactId,
    workspaceId: value.workspaceId,
    path: value.path,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    mediaType: value.mediaType,
    mode: value.mode,
    isText: value.isText === 1,
    createdAt: value.createdAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
