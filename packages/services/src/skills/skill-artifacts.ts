import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createSkillArtifactSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  upsertContentBlobSync,
  setActiveArtifactDigestForSkillSync,
  type CreateSkillArtifactInput,
  type SkillArtifactFileInput,
  type SkillArtifactFileRecord,
  type SkillArtifactRecord,
} from "@dofe-agent/db";
import {
  createAttachmentStorageClient,
  sha256Hex,
} from "../attachments/storage.ts";
import { normalizeSkillFilePath } from "../shared/helpers.ts";
import type { SkillDependencyDeclaration } from "./dependencies.ts";

/* ------------------------------------------------------------------ */
/* DSP manifest types (Dofe Skill Package v1)                          */
/* ------------------------------------------------------------------ */

export interface SkillArtifactManifestFile {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  mode: string;
}

export interface SkillArtifactManifest {
  schemaVersion: number;
  artifact: { name: string; version: string };
  files: SkillArtifactManifestFile[];
  dependencies: SkillDependencyDeclaration[];
  source?: { type?: string; url?: string };
}

export interface ArtifactFileInput {
  path: string;
  bytes: Uint8Array;
  mode?: string;
}

export interface BuildArtifactResult {
  artifact: SkillArtifactRecord;
  manifest: SkillArtifactManifest;
  digest: string;
  created: boolean;
}

/* ------------------------------------------------------------------ */
/* Media type + text classification                                    */
/* ------------------------------------------------------------------ */

const TEXT_MEDIA_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "text/html",
  "text/css",
  "text/javascript",
  "text/x-python",
  "text/x-shellscript",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
]);

const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".rb", ".pl"]);

/** Comprehensive extension → media type map covering text + binary skill resources. */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".csv": "text/csv",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  // binary
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".bin": "application/octet-stream",
};

export function mediaTypeForPath(path: string): string {
  const normalized = path.toLowerCase();
  const extension = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")) : "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "application/octet-stream";
}

export function isTextMediaType(mediaType: string): boolean {
  if (TEXT_MEDIA_TYPES.has(mediaType)) {
    return true;
  }
  return mediaType.startsWith("text/") || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

function deriveFileMode(path: string, override?: string): string {
  if (override && /^0?[0-7]{3,4}$/.test(override)) {
    return override;
  }
  const extension = path.toLowerCase().slice(path.lastIndexOf("."));
  return EXECUTABLE_SCRIPT_EXTENSIONS.has(extension) ? "0755" : "0644";
}

/* ------------------------------------------------------------------ */
/* Deterministic digest                                                */
/* ------------------------------------------------------------------ */

/**
 * Artifact root digest = sha256 of (canonical manifest JSON, artifact.sha256
 * blanked AND `source` excluded) concatenated with the sorted-by-path file
 * digests.
 *
 * `source` (provenance: type/url) is deliberately EXCLUDED so the digest is a
 * pure function of content. The same logical skill imported from a directory,
 * a ZIP, Git, or a registry mirror all produce the same digest — which is what
 * makes re-import idempotent (`readSkillArtifactByDigestSync` dedup) and what
 * the DSP contract requires (02-架构设计.md §2: "Git/注册表链接只用于发现").
 */
export function computeArtifactDigest(
  manifest: SkillArtifactManifest,
  fileDigestsSortedByPath: string[],
): string {
  // Strip provenance so two imports of identical content from different sources
  // collide on the same digest.
  const { source: _excludedSource, ...manifestWithoutSource } = manifest;
  const manifestForHash: SkillArtifactManifest = {
    ...manifestWithoutSource,
    artifact: { name: manifest.artifact.name, version: manifest.artifact.version },
  };
  const canonicalManifest = stableStringify(manifestForHash);
  const hash = createHash("sha256");
  hash.update(canonicalManifest);
  hash.update("\n");
  hash.update(fileDigestsSortedByPath.join("\n"));
  return hash.digest("hex");
}

/** Stable JSON stringify: object keys sorted recursively, no whitespace. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Build + persist                                                     */
/* ------------------------------------------------------------------ */

export interface BuildAndPersistSkillArtifactInput {
  workspaceId?: string;
  skillId?: string;
  name: string;
  version?: string;
  files: ArtifactFileInput[];
  sourceType?: string;
  sourceUrl?: string;
  provenance?: Record<string, unknown>;
  dependencies?: SkillDependencyDeclaration[];
  manifestSchemaVersion?: number;
}

/**
 * Reads every file as bytes, uploads content-addressed blobs (dedup), builds a
 * deterministic DSP manifest, computes the artifact digest, and persists the
 * immutable artifact. Idempotent: re-importing identical content returns the
 * existing artifact without re-uploading or duplicating file rows.
 */
export function buildAndPersistSkillArtifactSync(
  input: BuildAndPersistSkillArtifactInput,
): BuildArtifactResult {
  const workspaceId = input.workspaceId ?? "default";
  const normalizedFiles = input.files
    .map((file) => ({ ...file, path: normalizeSkillFilePath(file.path) }))
    .filter((file) => file.path.length > 0 && file.bytes.byteLength > 0);

  if (!normalizedFiles.some((file) => file.path === "SKILL.md")) {
    throw new Error("Skill artifact must contain SKILL.md.");
  }
  if (normalizedFiles.length === 0) {
    throw new Error("Skill artifact must contain at least one file.");
  }

  // De-duplicate by path (last wins), then sort deterministically.
  const byPath = new Map<string, ArtifactFileInput>();
  for (const file of normalizedFiles) {
    byPath.set(file.path, file);
  }
  const sortedFiles = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, "en-US"));

  // 1. Compute per-file digests + metadata (no uploads yet).
  let totalSizeBytes = 0;
  const manifestFiles: SkillArtifactManifestFile[] = sortedFiles.map((file) => {
    const sha256 = sha256Hex(file.bytes);
    const mediaType = mediaTypeForPath(file.path);
    const mode = deriveFileMode(file.path, file.mode);
    const size = file.bytes.byteLength;
    totalSizeBytes += size;
    return { path: file.path, sha256, size, mediaType, mode };
  });

  // 2. Build manifest + root digest. The digest depends only on file digests +
  //    manifest content, so we can short-circuit before any upload.
  const manifest: SkillArtifactManifest = {
    schemaVersion: input.manifestSchemaVersion ?? 1,
    artifact: { name: input.name, version: input.version ?? "" },
    files: manifestFiles,
    dependencies: input.dependencies ?? [],
    source: { type: input.sourceType, url: input.sourceUrl },
  };
  const digest = computeArtifactDigest(manifest, manifestFiles.map((file) => file.sha256));

  // 3. Idempotent short-circuit: identical content → existing artifact, no upload.
  const existing = readSkillArtifactByDigestSync(digest, workspaceId);
  if (existing) {
    return { artifact: existing, manifest, digest, created: false };
  }

  // 4. Upload content-addressed blobs (dedup at storage + index layers).
  const storage = createAttachmentStorageClient();
  for (let index = 0; index < sortedFiles.length; index += 1) {
    const file = sortedFiles[index]!;
    const entry = manifestFiles[index]!;
    const ref = storage.putContentAddressedBlobSync({
      workspaceId,
      sha256: entry.sha256,
      contentBytes: file.bytes,
      mediaType: entry.mediaType,
    });
    upsertContentBlobSync({
      workspaceId,
      sha256: entry.sha256,
      storageProvider: ref.storageProvider,
      storageBucket: ref.storageBucket,
      storageRegion: ref.storageRegion,
      storageEndpoint: ref.storageEndpoint,
      storageKey: ref.storageKey,
      sizeBytes: entry.size,
      mediaType: entry.mediaType,
    });
  }

  // 5. Persist the immutable artifact + file rows.
  const fileInputs: SkillArtifactFileInput[] = manifestFiles.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    sizeBytes: entry.size,
    mediaType: entry.mediaType,
    mode: entry.mode,
    isText: isTextMediaType(entry.mediaType),
  }));

  const artifact = createSkillArtifactSync({
    workspaceId,
    digest,
    skillId: input.skillId,
    name: input.name,
    version: input.version,
    manifestVersion: manifest.schemaVersion,
    manifestJson: stableStringify(manifest),
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    provenanceJson: JSON.stringify(input.provenance ?? {}),
    fileCount: manifestFiles.length,
    totalSizeBytes,
    files: fileInputs,
  });

  if (input.skillId) {
    setActiveArtifactDigestForSkillSync({ skillId: input.skillId, digest, workspaceId });
  }

  return { artifact, manifest, digest, created: true };
}

/* ------------------------------------------------------------------ */
/* Verify integrity                                                    */
/* ------------------------------------------------------------------ */

export interface ArtifactIntegrityResult {
  ok: boolean;
  digest: string;
  missing: string[];
  mismatched: Array<{ path: string; expected: string; actual: string }>;
  rootDigestMatches: boolean;
}

/**
 * Re-reads every blob, recomputes its sha256, recomputes the artifact root
 * digest, and compares against the stored artifact. Any mismatch → ok:false.
 */
export function verifySkillArtifactIntegritySync(
  artifact: SkillArtifactRecord,
  files?: SkillArtifactFileRecord[],
): ArtifactIntegrityResult {
  const workspaceId = artifact.workspaceId;
  const fileRecords = files ?? readSkillArtifactFilesSync(artifact.id);
  const storage = createAttachmentStorageClient();
  const manifest: SkillArtifactManifest = JSON.parse(artifact.manifestJson);

  const missing: string[] = [];
  const mismatched: Array<{ path: string; expected: string; actual: string }> = [];

  for (const file of fileRecords) {
    if (!storage.contentAddressedBlobExistsSync({ workspaceId, sha256: file.sha256 })) {
      missing.push(file.path);
      continue;
    }
    const bytes = storage.getContentAddressedBlobSync({ workspaceId, sha256: file.sha256 });
    const actual = sha256Hex(bytes);
    if (actual !== file.sha256) {
      mismatched.push({ path: file.path, expected: file.sha256, actual });
    }
  }

  const recomputedDigest = computeArtifactDigest(manifest, fileRecords.map((file) => file.sha256).sort());
  const rootDigestMatches = recomputedDigest === artifact.digest;

  return {
    ok: missing.length === 0 && mismatched.length === 0 && rootDigestMatches,
    digest: artifact.digest,
    missing,
    mismatched,
    rootDigestMatches,
  };
}

/* ------------------------------------------------------------------ */
/* Materialize (restore files from artifact into a target directory)   */
/* ------------------------------------------------------------------ */

export interface MaterializeArtifactResult {
  targetDir: string;
  restoredFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
}

/**
 * Restores the full file set (including binaries + executable modes) from an
 * immutable artifact into `targetDir`. Path traversal is rejected. Used by the
 * runtime materialization path and by recovery to rebuild the skill projection.
 */
export function materializeSkillArtifactFilesSync(
  artifact: SkillArtifactRecord,
  targetDir: string,
  files?: SkillArtifactFileRecord[],
): MaterializeArtifactResult {
  const fileRecords = files ?? readSkillArtifactFilesSync(artifact.id);
  const storage = createAttachmentStorageClient();
  const root = resolve(targetDir);
  const restored: Array<{ path: string; sha256: string; sizeBytes: number }> = [];

  for (const file of fileRecords) {
    const safeRelative = normalizeSkillFilePath(file.path);
    if (!safeRelative) {
      throw new Error(`Artifact file path is invalid: ${file.path}`);
    }
    const targetPath = resolve(root, safeRelative);
    const relativePath = relative(root, targetPath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Artifact file path escapes target directory: ${file.path}`);
    }

    const bytes = storage.getContentAddressedBlobSync({ workspaceId: artifact.workspaceId, sha256: file.sha256 });
    const actualDigest = sha256Hex(bytes);
    if (actualDigest !== file.sha256) {
      throw new Error(
        `Artifact integrity check failed for "${file.path}": expected ${file.sha256}, got ${actualDigest}.`,
      );
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, bytes);
    if (file.mode === "0755") {
      try {
        chmodSync(targetPath, 0o755);
      } catch {
        // chmod may fail on some platforms; non-fatal for projection.
      }
    }
    restored.push({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes });
  }

  return { targetDir: root, restoredFiles: restored };
}

/* ------------------------------------------------------------------ */
/* Migration helper: legacy skill → artifact                            */
/* ------------------------------------------------------------------ */

/**
 * Builds an artifact from an existing text-only skill (skill_file rows). Files
 * that cannot be read are recorded as missing and the artifact is marked
 * legacy_incomplete so it cannot be silently treated as fully verified. Per the
 * design, incomplete legacy skills forbid new bindings until re-imported.
 */
export function buildLegacyArtifactFromSkillSync(input: {
  workspaceId?: string;
  skillId: string;
  name: string;
  files: Array<{ path: string; content: string }>;
  sourceType?: string;
  sourceUrl?: string;
}): BuildArtifactResult {
  const encoder = new TextEncoder();
  const fileInputs: ArtifactFileInput[] = input.files
    .filter((file) => typeof file.content === "string")
    .map((file) => ({ path: file.path, bytes: encoder.encode(file.content) }));

  if (!fileInputs.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Legacy skill "${input.name}" is missing SKILL.md; cannot build artifact.`);
  }

  return buildAndPersistSkillArtifactSync({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    name: input.name,
    files: fileInputs,
    sourceType: input.sourceType ?? "legacy",
    sourceUrl: input.sourceUrl,
    provenance: { legacy: true, migratedAt: new Date().toISOString() },
  });
}
