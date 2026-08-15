import { createHash } from "node:crypto";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import {
  getDatabase,
  listSkillArtifactBindingsForSkillSync,
  listStoredWorkspaceSkillsSync,
  readActiveArtifactDigestForSkillSync,
  readSkillArtifactByDigestSync,
  recordStoredSkillImportEventSync,
  setActiveArtifactDigestForSkillSync,
  upsertSkillArtifactBindingSync,
  withTransaction,
} from "@dofe-agent/db";
import { strFromU8, unzipSync } from "fflate";
import {
  normalizeSkillFilePath,
  sameValue,
} from "../shared/helpers.ts";
import { createUniqueWorkspaceSkillName } from "../shared/normalizers.ts";
import {
  createWorkspaceSkillSync,
  deleteWorkspaceSkillFileSync,
  isBuiltinSkill,
  listWorkspaceSkillsSync,
  readWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
} from "./skills.ts";
import { parseSkillMetadata } from "./skill-metadata.ts";
import { parseSkillDependencyDeclarations } from "./dependencies.ts";
import { parseSkillRequirementDeclarations } from "./requirements.ts";
import { gitAuthHeadersSync, resolveWorkspaceGitCredentialSecretSync } from "./git-credentials.ts";
import { notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";
import {
  deleteWorkspaceAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  readWorkspaceAttachmentBytesSync,
} from "../attachments/attachments.ts";
import { buildAndPersistSkillArtifactSync } from "./skill-artifacts.ts";
import {
  validateSkillPackage,
  type SkillPackageInputFile,
} from "./package/package-validator.ts";
import {
  MAX_SKILL_ARCHIVE_BYTES,
  MAX_SKILL_ARCHIVE_FILES,
  MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_SKILL_ARCHIVE_NESTING_DEPTH,
  MAX_SKILL_PACKAGE_FILES,
  MAX_SKILL_SINGLE_FILE_BYTES,
} from "./package/archive-limits.ts";
import { classifySkillFilePath } from "./package/path-safety.ts";
import { classifySkillFile } from "./package/skill-file-policy.ts";

export type SkillImportConflict = "reject" | "rename" | "replace" | "skip";
export type SkillImportSourceType = "github" | "gitlab" | "skills.sh" | "clawhub" | "local" | "tos";

/**
 * Stable product-facing error codes for GitHub skill imports
 * (docs/0801/skill-install/14 §Implementation Decisions). The Web layer maps
 * each code to a localized message + remedy instead of showing the raw
 * internal English exception.
 */
export type SkillGitHubImportErrorCode =
  | "skill.github.url_invalid"
  | "skill.github.not_found"
  | "skill.github.no_skill"
  | "skill.github.multiple_skills"
  | "skill.github.tree_truncated"
  | "skill.github.rate_limited"
  | "skill.github.unauthorized"
  | "skill.github.file_download_failed"
  | "skill.github.unavailable";

/** A GitHub import failure carrying a stable {@link SkillGitHubImportErrorCode} plus structured payloads for the UI. */
export class SkillGitHubImportError extends Error {
  readonly code: SkillGitHubImportErrorCode;
  /** Candidate skill directories (multiple_skills) — the user picks one or pastes its tree URL. "" means the repository root. */
  readonly candidates?: string[];
  /** Epoch seconds when the shared GitHub API quota resets (rate_limited). */
  readonly retryAtEpochSeconds?: number;

  constructor(
    code: SkillGitHubImportErrorCode,
    message: string,
    options?: { candidates?: string[]; retryAtEpochSeconds?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "SkillGitHubImportError";
    this.code = code;
    if (options?.candidates) this.candidates = options.candidates;
    if (options?.retryAtEpochSeconds !== undefined) this.retryAtEpochSeconds = options.retryAtEpochSeconds;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Maps a failed GitHub API response onto the stable product error codes (auth / quota / existence / availability). */
function skillGitHubHttpError(response: Response, context: string): SkillGitHubImportError {
  if (response.status === 404) {
    return new SkillGitHubImportError(
      "skill.github.not_found",
      `${context}: repository, ref, or path not found (HTTP 404).`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    // GitHub answers quota exhaustion as 403 with X-RateLimit-Remaining: 0 —
    // that is a retryable availability state, distinct from a bad credential.
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const resetHeader = Number(response.headers.get("x-ratelimit-reset"));
      return new SkillGitHubImportError(
        "skill.github.rate_limited",
        `${context}: GitHub API rate limit exhausted (HTTP ${response.status}).`,
        Number.isSafeInteger(resetHeader) && resetHeader > 0 ? { retryAtEpochSeconds: resetHeader } : undefined,
      );
    }
    return new SkillGitHubImportError(
      "skill.github.unauthorized",
      `${context}: credentials lack access (HTTP ${response.status}).`,
    );
  }
  return new SkillGitHubImportError(
    "skill.github.unavailable",
    `${context}: GitHub API unavailable (HTTP ${response.status}).`,
  );
}

export interface SkillImportResult {
  skillId: string;
  skillName: string;
  sourceUrl: string;
  created: boolean;
  renamed: boolean;
  replaced: boolean;
  skipped: boolean;
  sourceType: SkillImportSourceType;
  requiresConfiguration: boolean;
  /** Immutable imported artifact digest. On replace this is a candidate until explicitly promoted. */
  artifactDigest?: string;
  /** Resolved skill directory inside the repository ("" = repository root; GitHub/GitLab imports). */
  resolvedPath?: string;
  /** Immutable commit SHA the import was locked to (GitHub/GitLab imports). */
  resolvedRef?: string;
  warnings: string[];
}

export type SkillSourceUpdateStatus =
  | "up_to_date"
  | "update_available"
  | "disabled"
  | "unsupported"
  | "not_checkable";

export interface SkillSourceUpdateInspection {
  skillId: string;
  sourceType?: string;
  sourceUrl?: string;
  status: SkillSourceUpdateStatus;
  currentResolvedRef?: string;
  latestResolvedRef?: string;
  reason?: string;
}

/**
 * An imported file carried as raw bytes (binary-safe). Text files additionally
 * decode to a UTF-8 string for the legacy text projection (skill_file); binary
 * files live only in the immutable artifact + content-addressed blob store.
 */
interface ImportedSkillFile {
  path: string;
  bytes: Uint8Array;
  mode?: string;
}

interface SkillSourceBudget {
  fileCount: number;
  totalBytes: number;
  requestCount: number;
}

const MAX_SKILL_SOURCE_REQUESTS = 256;
const GITHUB_RAW_DOWNLOAD_CONCURRENCY = 4;
const GITHUB_RAW_DOWNLOAD_TIMEOUT_MS = 5_000;
const MAX_SKILL_SOURCE_METADATA_BYTES = 2 * 1024 * 1024;

interface ImportedSkillDefinition {
  name: string;
  description: string;
  files: ImportedSkillFile[];
  sourceType: SkillImportSourceType;
  sourceUrl: string;
  configJson: string;
  warnings: string[];
  /** Immutable commit SHA / registry digest; execution and audit must use this. */
  resolvedRef?: string;
  /** Resolved skill directory inside the repository ("" = repository root). */
  resolvedPath?: string;
  /** Original user-submitted URL (mutable branch/tag allowed here). */
  originalUrl?: string;
}

interface GitHubDirectoryPointer {
  owner: string;
  repo: string;
  /** Original branch/tag/ref from the user URL. */
  ref: string;
  path: string;
  /** Immutable commit SHA resolved from `ref` before any content fetch. */
  resolvedSha?: string;
  /** Immutable tree entries captured while discovering a repository-root URL. */
  discoveredFiles?: Array<{ path: string; mode?: string; sha?: string; size?: number }>;
  /** API requests already spent resolving a repository-root URL. */
  discoveryRequestCount?: number;
}

interface GitLabDirectoryPointer {
  /** URL-encoded as one API project identifier, including namespace segments. */
  projectPath: string;
  /** Original branch/tag/ref from the user URL. */
  ref: string;
  path: string;
  /** Immutable commit SHA resolved from `ref` before any content fetch. */
  resolvedSha?: string;
}

export async function importWorkspaceSkillFromUrl(input: {
  workspaceId?: string;
  url: string;
  conflict?: SkillImportConflict;
  allowFilesystemSource?: boolean;
  allowedFilesystemRoots?: string[];
}): Promise<SkillImportResult> {
  const workspaceId = input.workspaceId;
  let sourceUrl = input.url.trim();
  if (!sourceUrl) {
    throw new Error("Skill import URL is required.");
  }
  let parsedSourceUrl = parseUrl(sourceUrl);
  if (!parsedSourceUrl || parsedSourceUrl.protocol === "file:") {
    if (input.allowedFilesystemRoots?.length) {
      const filesystemPath = parsedSourceUrl?.protocol === "file:"
        ? fileURLToPath(parsedSourceUrl)
        : sourceUrl;
      sourceUrl = await resolveAllowedFilesystemSkillSource(filesystemPath, input.allowedFilesystemRoots);
      parsedSourceUrl = null;
    } else if (!input.allowFilesystemSource) {
      throw new Error("Filesystem skill sources are not allowed for this import channel.");
    }
  }

  const hasRecordedStoredSource = listWorkspaceSkillsSync(workspaceId).some(
    (skill) => (skill.sourceType === "tos" || skill.sourceType === "local") && sameValue(skill.sourceUrl ?? "", sourceUrl),
  );
  // Private-repo import: record a single "Git credential used" audit event if a
  // credential is configured for the host (the per-request fetch headers are silent).
  if (workspaceId && (parsedSourceUrl?.hostname === "github.com" || parsedSourceUrl?.hostname === "gitlab.com")) {
    resolveWorkspaceGitCredentialSecretSync({
      workspaceId,
      host: parsedSourceUrl.hostname,
      actorDisplayName: "skill import",
    });
  }
  const imported = await importSkillDefinition(sourceUrl, { hasRecordedStoredSource, workspaceId });
  return persistImportedSkillDefinition(imported, workspaceId, input.conflict);
}

async function resolveAllowedFilesystemSkillSource(sourcePath: string, allowedRoots: string[]): Promise<string> {
  const candidate = await realpath(resolve(sourcePath));
  const roots = await Promise.all(allowedRoots.map(async (configuredRoot) => {
    const trimmedRoot = configuredRoot.trim();
    if (!trimmedRoot) return null;
    if (!isAbsolute(trimmedRoot)) {
      throw new Error(`Skill local import root must be absolute: ${trimmedRoot}`);
    }
    return realpath(trimmedRoot);
  }));
  for (const root of roots) {
    if (!root) continue;
    const relativePath = relative(root, candidate);
    if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) {
      return candidate;
    }
  }
  throw new Error("Skill local import path is outside the configured server roots.");
}

/**
 * Resolves a mutable Git source ref without downloading package contents or
 * writing an artifact. Candidate creation remains an explicit re-import step.
 */
export async function inspectWorkspaceSkillSourceUpdate(input: {
  workspaceId?: string;
  skillId: string;
}): Promise<SkillSourceUpdateInspection> {
  const workspaceId = input.workspaceId ?? "default";
  const skillId = input.skillId.trim();
  const skill = readWorkspaceSkillSync(skillId, workspaceId);
  if (!skill) {
    throw new Error(`Skill "${skillId}" does not exist.`);
  }
  const base = {
    skillId,
    ...(skill.sourceType ? { sourceType: skill.sourceType } : {}),
    ...(skill.sourceUrl ? { sourceUrl: skill.sourceUrl } : {}),
  };
  if (process.env.DOFE_SKILL_SOURCE_UPDATE_CHECKS_ENABLED?.trim().toLowerCase() === "false") {
    return { ...base, status: "disabled", reason: "skill_source_updates_disabled" };
  }
  if (!skill.sourceUrl || (skill.sourceType !== "github" && skill.sourceType !== "gitlab")) {
    return { ...base, status: "unsupported", reason: "skill_source_update_provider_unsupported" };
  }

  const activeDigest = readActiveArtifactDigestForSkillSync(skillId, workspaceId);
  const activeArtifact = activeDigest ? readSkillArtifactByDigestSync(activeDigest, workspaceId) : null;
  const provenance = activeArtifact ? parseJsonSafely(activeArtifact.provenanceJson) : undefined;
  const artifactResolvedRef = readResolvedRef(provenance);
  const bindings = listSkillArtifactBindingsForSkillSync(skillId, workspaceId);
  const skillResolvedRef = bindings.length === 1 ? readResolvedRef(parseJsonSafely(skill.configJson)) : undefined;
  const currentResolvedRef = artifactResolvedRef ?? skillResolvedRef;
  if (!activeArtifact || !currentResolvedRef) {
    return { ...base, status: "not_checkable", reason: "skill_source_active_ref_missing" };
  }

  let latestResolvedRef: string;
  if (skill.sourceType === "github") {
    const resolvedSha = await resolveGitHubSourceSha(skill.sourceUrl, workspaceId);
    if (!resolvedSha) {
      return { ...base, status: "not_checkable", currentResolvedRef, reason: "skill_source_url_invalid" };
    }
    latestResolvedRef = resolvedSha;
  } else {
    const pointer = parseGitLabDirectoryUrl(skill.sourceUrl);
    if (!pointer) {
      return { ...base, status: "not_checkable", currentResolvedRef, reason: "skill_source_url_invalid" };
    }
    latestResolvedRef = await resolveGitLabRefToSha(
      pointer.projectPath,
      pointer.ref,
      { fileCount: 0, totalBytes: 0, requestCount: 0 },
      workspaceId,
    );
  }

  return {
    ...base,
    status: latestResolvedRef === currentResolvedRef ? "up_to_date" : "update_available",
    currentResolvedRef,
    latestResolvedRef,
  };
}

export interface SkillSourceUpdateCheckSummary {
  checked: number;
  updateAvailable: number;
  notificationsCreated: number;
  errors: Array<{ skillId: string; reason: string }>;
}

/**
 * Registry / Git-source periodic update check (P1-3): scans every GitHub/GitLab
 * sourced skill in the workspace, resolves the latest source ref, and notifies
 * workspace admins when a new candidate is available. Deduped per
 * (skillId, latestRef) so repeated runs never stack duplicate notifications.
 * Callable from a scheduler; returns a summary for SLO/audit.
 */
export async function checkSkillSourceUpdatesForWorkspaceSync(input: {
  workspaceId?: string;
}): Promise<SkillSourceUpdateCheckSummary> {
  const workspaceId = input.workspaceId ?? "default";
  const summary: SkillSourceUpdateCheckSummary = { checked: 0, updateAvailable: 0, notificationsCreated: 0, errors: [] };
  const gitSkills = listStoredWorkspaceSkillsSync(workspaceId).filter(
    (skill) => (skill.sourceType === "github" || skill.sourceType === "gitlab") && Boolean(skill.sourceUrl),
  );
  for (const skill of gitSkills) {
    try {
      const inspection = await inspectWorkspaceSkillSourceUpdate({ workspaceId, skillId: skill.id });
      summary.checked += 1;
      if (inspection.status !== "update_available" || !inspection.latestResolvedRef) {
        continue;
      }
      summary.updateAvailable += 1;
      const created = notifyWorkspaceAdminsSync({
        workspaceId,
        title: "Skill 有可用更新",
        body: `Skill "${skill.name}" 有新的候选版本（${inspection.latestResolvedRef.slice(0, 8)}…）。`,
        type: "skill_source_update",
        severity: "info",
        resourceType: "skill",
        resourceId: skill.id,
        actionHref: `/skills?skill=${encodeURIComponent(skill.id)}`,
        dedupeKey: `skill_source_update:${skill.id}:${inspection.latestResolvedRef}`,
      });
      summary.notificationsCreated += created.length;
    } catch (error) {
      summary.errors.push({ skillId: skill.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

export async function importWorkspaceSkillFromZipUpload(input: {
  workspaceId?: string;
  fileName: string;
  contentBytes: Uint8Array;
  conflict?: SkillImportConflict;
}): Promise<SkillImportResult> {
  const fileName = basename(input.fileName.trim());
  if (!fileName.toLowerCase().endsWith(".zip")) {
    throw new Error("Skill upload must be a .zip archive.");
  }
  if (input.contentBytes.byteLength === 0) {
    throw new Error("Skill archive cannot be empty.");
  }
  if (input.contentBytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error("Skill archive exceeds the 10 MB upload limit.");
  }

  const sourceAttachment = persistWorkspaceAttachmentFromBytesSync({
    workspaceId: input.workspaceId,
    fileName,
    mediaType: "application/zip",
    contentBytes: input.contentBytes,
  });

  try {
    // Parse the persisted object instead of trusting the browser upload bytes.
    const archiveBytes = readWorkspaceAttachmentBytesSync(sourceAttachment);
    const imported = importStoredSkillDefinition(archiveBytes, sourceAttachment);
    const result = await persistImportedSkillDefinition(imported, input.workspaceId, input.conflict);
    if (result.skipped) {
      deleteWorkspaceAttachmentsSync([sourceAttachment]);
    }
    return result;
  } catch (error) {
    deleteWorkspaceAttachmentsSync([sourceAttachment]);
    throw error;
  }
}

async function persistImportedSkillDefinition(
  imported: ImportedSkillDefinition,
  workspaceId?: string,
  requestedConflict?: SkillImportConflict,
): Promise<SkillImportResult> {
  const resolvedWorkspaceId = workspaceId ?? "default";
  const existingSkills = listWorkspaceSkillsSync(resolvedWorkspaceId);
  const existing = existingSkills.find((skill) => sameValue(skill.name, imported.name));

  const conflict = requestedConflict ?? "reject";
  if (existing && conflict === "reject") {
    throw new Error(`Skill "${existing.name}" already exists. Use --conflict rename or --conflict replace.`);
  }
  if (existing && conflict === "skip") {
    return {
      skillId: existing.id,
      skillName: existing.name,
      sourceUrl: imported.sourceUrl,
      created: false,
      renamed: false,
      replaced: false,
      skipped: true,
      sourceType: imported.sourceType,
      requiresConfiguration: parseSkillRequirementDeclarations(readSkillMarkdown(imported.files)).length > 0,
      resolvedPath: imported.resolvedPath,
      resolvedRef: imported.resolvedRef,
      warnings: [...imported.warnings, `Skipped existing skill "${existing.name}".`],
    };
  }

  if (existing && conflict === "replace" && isBuiltinSkill(existing.name)) {
    throw new Error(`Builtin skill "${existing.name}" cannot be replaced by an import.`);
  }

  // Validate and persist the immutable artifact BEFORE touching the Skill row.
  // The artifact is content-addressed, so a failed transaction leaves only
  // orphan blobs that can be garbage-collected later; it does not leave a
  // partially-imported Skill or inconsistent active digest.
  const artifactDigest = prepareSkillArtifact(imported, resolvedWorkspaceId);

  const targetName = (existing && conflict === "rename") || isBuiltinSkill(imported.name)
    ? createUniqueImportSkillName(existingSkills, imported.name)
    : imported.name;

  if (existing && conflict === "replace") {
    return withTransaction(getDatabase(), () =>
      commitReplacedSkillImport(existing, imported, artifactDigest, resolvedWorkspaceId),
    );
  }

  return withTransaction(getDatabase(), () =>
    commitCreatedSkillImport(imported, artifactDigest, targetName, resolvedWorkspaceId),
  );
}

function commitCreatedSkillImport(
  imported: ImportedSkillDefinition,
  artifactDigest: string | undefined,
  skillName: string,
  workspaceId: string,
): SkillImportResult {
  const created = createWorkspaceSkillSync({
    name: skillName,
    description: imported.description,
    content: readSkillMarkdown(imported.files),
    sourceType: imported.sourceType,
    sourceUrl: imported.sourceUrl,
    configJson: imported.configJson,
  }, workspaceId);

  upsertTextProjectionFiles(created.id, imported.files, workspaceId);

  if (artifactDigest) {
    setActiveArtifactDigestForSkillSync({ skillId: created.id, digest: artifactDigest, workspaceId });
  }

  recordStoredSkillImportEventSync({
    workspaceId,
    skillId: created.id,
    skillName: created.name,
    sourceType: imported.sourceType,
    sourceUrl: imported.sourceUrl,
    importMode: sameValue(created.name, imported.name) ? "created" : "renamed",
    metadataJson: imported.configJson,
  });

  return {
    skillId: created.id,
    skillName: created.name,
    sourceUrl: imported.sourceUrl,
    created: true,
    renamed: !sameValue(created.name, imported.name),
    replaced: false,
    skipped: false,
    sourceType: imported.sourceType,
    requiresConfiguration: parseSkillRequirementDeclarations(readSkillMarkdown(imported.files)).length > 0,
    artifactDigest,
    resolvedPath: imported.resolvedPath,
    resolvedRef: imported.resolvedRef,
    warnings: imported.warnings,
  };
}

function commitReplacedSkillImport(
  existing: WorkspaceSkill,
  imported: ImportedSkillDefinition,
  artifactDigest: string | undefined,
  workspaceId: string,
): SkillImportResult {
  const current = readWorkspaceSkillSync(existing.id, workspaceId);
  if (!current) {
    throw new Error(`Skill "${existing.id}" does not exist.`);
  }
  const activeDigest = readActiveArtifactDigestForSkillSync(current.id, workspaceId);
  let refreshed = current;

  // Legacy/manual Skills without an active artifact adopt their first validated
  // replacement immediately. Once an active artifact exists, re-import is a
  // candidate-only operation: the compatibility projection must not move ahead
  // of the digest used by tasks and assignments.
  if (!activeDigest) {
    const updated = updateWorkspaceSkillSync({
      skillId: current.id,
      name: current.name,
      description: imported.description,
      sourceType: imported.sourceType,
      sourceUrl: imported.sourceUrl,
      configJson: imported.configJson,
    }, workspaceId);
    upsertTextProjectionFiles(updated.id, imported.files, workspaceId);
    refreshed = readWorkspaceSkillSync(updated.id, workspaceId) ?? updated;
    const importedPaths = new Set(imported.files.map((file) => file.path.toLocaleLowerCase("en-US")));
    for (const file of refreshed.files) {
      if (!importedPaths.has(file.path.toLocaleLowerCase("en-US")) && !sameValue(file.path, "SKILL.md")) {
        deleteWorkspaceSkillFileSync(refreshed.id, file.id, workspaceId);
      }
    }
  }

  if (artifactDigest) {
    upsertSkillArtifactBindingSync({ skillId: refreshed.id, digest: artifactDigest, workspaceId });
    if (!activeDigest) {
      setActiveArtifactDigestForSkillSync({ skillId: refreshed.id, digest: artifactDigest, workspaceId });
    }
  }

  recordStoredSkillImportEventSync({
    workspaceId,
    skillId: refreshed.id,
    skillName: refreshed.name,
    sourceType: imported.sourceType,
    sourceUrl: imported.sourceUrl,
    importMode: "replaced",
    metadataJson: imported.configJson,
  });

  return {
    skillId: refreshed.id,
    skillName: refreshed.name,
    sourceUrl: imported.sourceUrl,
    created: false,
    renamed: false,
    replaced: true,
    skipped: false,
    sourceType: imported.sourceType,
    requiresConfiguration: parseSkillRequirementDeclarations(readSkillMarkdown(imported.files)).length > 0,
    artifactDigest,
    resolvedPath: imported.resolvedPath,
    resolvedRef: imported.resolvedRef,
    warnings: imported.warnings,
  };
}

function upsertTextProjectionFiles(skillId: string, files: ImportedSkillFile[], workspaceId: string): void {
  for (const file of files) {
    if (sameValue(file.path, "SKILL.md")) {
      continue;
    }
    if (!classifySkillFile(file.path, file.bytes).inlineableText) {
      continue; // binary files live only in the artifact
    }
    upsertWorkspaceSkillFileSync({
      skillId,
      path: file.path,
      content: decodeUtf8(file.bytes),
    }, workspaceId);
  }
}

/**
 * Validates the package and persists the immutable content-addressed artifact
 * from the full file set (text + binary). The resulting digest is pinned on the
 * skill row inside the same transaction that commits the Skill. Per EAD-004:
 * every declared file — including scripts and binary resources — must be present;
 * a manifest that omits files cannot represent a "successful" import.
 */
/**
 * Derives a stable logical coordinate from the import source, matching the
 * `coordinate` shape declared in `skillDependencies`. Version-independent: the
 * ref/commit SHA is deliberately excluded (version is a separate axis).
 */
export function deriveSkillCoordinate(
  sourceType: string | undefined,
  sourceUrl: string,
  resolvedPath?: string,
): string | undefined {
  const path = (resolvedPath ?? "").replace(/^\/+|\/+$/g, "");
  if (sourceType === "github") {
    const dir = parseGitHubDirectoryUrl(sourceUrl);
    if (dir) {
      return path ? `github:${dir.owner}/${dir.repo}/${path}` : `github:${dir.owner}/${dir.repo}`;
    }
    const repo = parseGitHubRepositoryUrl(sourceUrl);
    if (repo) {
      return path ? `github:${repo.owner}/${repo.repo}/${path}` : `github:${repo.owner}/${repo.repo}`;
    }
  }
  if (sourceType === "gitlab") {
    const dir = parseGitLabDirectoryUrl(sourceUrl);
    if (dir) {
      return path ? `gitlab:${dir.projectPath}/${path}` : `gitlab:${dir.projectPath}`;
    }
  }
  return undefined;
}

function prepareSkillArtifact(
  imported: ImportedSkillDefinition,
  workspaceId: string,
): string | undefined {
  try {
    const packageFiles: SkillPackageInputFile[] = imported.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      mode: file.mode,
    }));
    const validation = validateSkillPackage({ files: packageFiles });
    if (!validation.ok) {
      const codes = validation.errors.map((error) => error.code).join(", ");
      const messages = validation.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
      throw new Error(`Package validation failed (${codes}): ${messages}`);
    }
    const manifest = validation.manifest;
    const bytesByPath = new Map(imported.files.map((file) => [normalizeSkillFilePath(file.path), file.bytes]));
    const artifactFiles = validation.files
      .filter((file) => file.path !== ".dofe/manifest.json")
      .map((file) => {
        const bytes = bytesByPath.get(file.path);
        if (!bytes) throw new Error(`Validated file "${file.path}" has no source bytes.`);
        return { path: file.path, bytes, mode: file.mode };
      });

    const result = buildAndPersistSkillArtifactSync({
      workspaceId,
      name: manifest!.artifact.name,
      version: manifest!.artifact.version,
      files: artifactFiles,
      sourceType: imported.sourceType,
      sourceUrl: imported.sourceUrl,
      coordinate: deriveSkillCoordinate(imported.sourceType, imported.sourceUrl, imported.resolvedPath),
      dependencies: (manifest?.dependencies ?? []).map((dependency) => ({
        manager: dependency.kind,
        name: dependency.name,
        version: dependency.version,
        ...(dependency.integrity ? { integrity: dependency.integrity } : {}),
      })),
      ...(manifest?.capabilities ? { capabilities: manifest.capabilities } : {}),
      ...(manifest?.services ? { services: manifest.services } : {}),
      ...(manifest?.entrypoints ? { entrypoints: manifest.entrypoints } : {}),
      provenance: {
        importedVia: imported.sourceType,
        sourceUrl: imported.sourceUrl,
        skillDescription: imported.description,
        skillConfig: parseJsonSafely(imported.configJson),
        ...(imported.resolvedRef ? { resolvedRef: imported.resolvedRef } : {}),
        ...(imported.originalUrl ? { originalUrl: imported.originalUrl } : {}),
      },
    });
    return result.digest;
  } catch (error) {
    // Artifact creation must not silently pass with missing files. Re-throw so
    // the import surfaces as failed/incomplete rather than a false success.
    throw new Error(
      `Failed to build skill artifact for "${imported.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function importSkillDefinition(
  sourceUrl: string,
  options: { hasRecordedStoredSource: boolean; workspaceId?: string } = { hasRecordedStoredSource: false },
): Promise<ImportedSkillDefinition> {
  const parsed = parseUrl(sourceUrl);
  if (!parsed) {
    return importLocalSkillDefinition(sourceUrl);
  }

  if (parsed.hostname === "skills.sh") {
    return importSkillsShSkillDefinition(sourceUrl, parsed, options.workspaceId);
  }
  if (parsed.hostname === "gitlab.com") {
    return importGitLabSkillDefinition(sourceUrl, options.workspaceId);
  }
  if (parsed.hostname === "clawhub.ai" || parsed.hostname.endsWith(".clawhub.ai")) {
    return importClawHubSkillDefinition(sourceUrl);
  }
  if (parsed.protocol === "file:") {
    return importLocalSkillDefinition(decodeURIComponent(parsed.pathname));
  }
  if (parsed.protocol === "tos:") {
    if (!options.hasRecordedStoredSource) {
      throw new Error("TOS skill sources must be created through a zip upload.");
    }
    return importStoredSkillDefinitionFromPath(sourceUrl, parsed, "tos");
  }
  if (parsed.protocol === "local:") {
    if (!options.hasRecordedStoredSource) {
      throw new Error("Local skill sources must be created through a zip upload.");
    }
    return importStoredSkillDefinitionFromPath(sourceUrl, parsed, "local");
  }
  return importGitHubSkillDefinition(sourceUrl, options.workspaceId);
}

function importStoredSkillDefinitionFromPath(
  sourceUrl: string,
  parsed: URL,
  provider: "tos" | "local",
): ImportedSkillDefinition {
  const storageKey = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  if (!storageKey || (provider === "tos" && !parsed.hostname)) {
    throw new Error("TOS skill source must include a bucket and object key.");
  }
  const archiveBytes = readWorkspaceAttachmentBytesSync({
    storedPath: sourceUrl,
    storageProvider: provider,
    storageBucket: provider === "tos" ? parsed.hostname : undefined,
    storageKey,
  });
  return importStoredSkillDefinition(archiveBytes, {
    fileName: basename(storageKey),
    storedPath: sourceUrl,
    storageProvider: provider,
    storageBucket: provider === "tos" ? parsed.hostname : undefined,
    storageKey,
    sizeBytes: archiveBytes.byteLength,
  });
}

function importStoredSkillDefinition(
  archiveBytes: Uint8Array,
  source: Pick<
    ReturnType<typeof persistWorkspaceAttachmentFromBytesSync>,
    "fileName" | "storedPath" | "storageProvider" | "storageBucket" | "storageRegion" | "storageEndpoint" | "storageKey" | "sha256" | "sizeBytes"
  >,
): ImportedSkillDefinition {
  const warnings: string[] = [];
  const provider = source.storageProvider ?? "tos";
  const files = readSkillZipFiles(archiveBytes, warnings, `${provider.toUpperCase()} skill archive`);
  const skillMd = readSkillMarkdown(files);
  const metadata = parseSkillMetadata(skillMd, deriveSkillNameFromPath(source.fileName));
  return {
    name: metadata.name,
    description: metadata.description,
    files,
    sourceType: provider,
    sourceUrl: source.storedPath,
    configJson: JSON.stringify({
      provider,
      storageKey: source.storageKey,
      storageBucket: source.storageBucket,
      storageRegion: source.storageRegion,
      storageEndpoint: source.storageEndpoint,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes ?? archiveBytes.byteLength,
      warnings,
      dependencies: parseSkillDependencyDeclarations(skillMd),
      requirements: parseSkillRequirementDeclarations(skillMd),
    }),
    warnings,
  };
}

async function importLocalSkillDefinition(sourcePath: string): Promise<ImportedSkillDefinition> {
  const absolutePath = resolve(sourcePath.trim());
  if (!absolutePath) {
    throw new Error("Local skill path is required.");
  }

  const stats = await stat(absolutePath).catch(() => null);
  if (!stats) {
    throw new Error(`Local skill path does not exist: ${absolutePath}`);
  }

  const warnings: string[] = [];
  let files: ImportedSkillFile[] = [];

  if (stats.isDirectory()) {
    files = await readLocalSkillDirectoryFiles(absolutePath, warnings);
  } else if (stats.isFile() && extname(absolutePath).toLowerCase() === ".zip") {
    files = await readLocalSkillZipFiles(absolutePath, warnings);
  } else if (stats.isFile() && sameValue(basename(absolutePath), "SKILL.md")) {
    const bytes = new Uint8Array(await readFile(absolutePath));
    assertSkillSourceFileBudget({ fileCount: 0, totalBytes: 0, requestCount: 0 }, "SKILL.md", bytes, "Local skill");
    files = [{
      path: "SKILL.md",
      bytes,
      mode: (stats.mode & 0o777).toString(8),
    }];
  } else {
    throw new Error("Local skill import currently supports a skill directory, a .zip archive, or a direct SKILL.md file.");
  }

  const skillMd = readSkillMarkdown(files);
  const metadata = parseSkillMetadata(skillMd, deriveSkillNameFromPath(absolutePath));

  return {
    name: metadata.name,
    description: metadata.description,
    files,
    sourceType: "local",
    sourceUrl: absolutePath,
    configJson: JSON.stringify({
      provider: "local",
      path: absolutePath,
      warnings,
    }),
    warnings,
  };
}

async function importGitHubSkillDefinition(sourceUrl: string, workspaceId?: string): Promise<ImportedSkillDefinition> {
  const pointer = await resolveGitHubSkillPointer(sourceUrl, workspaceId);
  if (!pointer) {
    throw new SkillGitHubImportError(
      "skill.github.url_invalid",
      "Only GitHub repository, tree, blob, or raw skill URLs are supported.",
    );
  }
  return importGitHubSkillDefinitionFromPointer(pointer, sourceUrl, "github", workspaceId);
}

async function importGitLabSkillDefinition(sourceUrl: string, workspaceId?: string): Promise<ImportedSkillDefinition> {
  const pointer = parseGitLabDirectoryUrl(sourceUrl);
  if (!pointer) {
    throw new Error("GitLab skill URL must use a gitlab.com /-/tree, /-/blob, or /-/raw path.");
  }

  const budget: SkillSourceBudget = { fileCount: 0, totalBytes: 0, requestCount: 0 };
  pointer.resolvedSha = await resolveGitLabRefToSha(pointer.projectPath, pointer.ref, budget, workspaceId);
  const resolvedRef = pointer.resolvedSha;
  const provenance = {
    provider: "gitlab",
    projectPath: pointer.projectPath,
    ref: pointer.ref,
    path: pointer.path,
    resolvedRef,
    originalUrl: sourceUrl,
  };

  let files: ImportedSkillFile[];
  const warnings: string[] = [];
  if (pointer.path.endsWith("/SKILL.md") || sameValue(pointer.path, "SKILL.md")) {
    const bytes = await fetchGitLabRawFile(pointer, budget, workspaceId);
    assertSkillSourceFileBudget(budget, "SKILL.md", bytes, "GitLab skill");
    files = [{ path: "SKILL.md", bytes }];
  } else {
    files = await fetchGitLabDirectoryFiles(pointer, warnings, budget, workspaceId);
  }

  const skillMd = readSkillMarkdown(files);
  const metadata = parseSkillMetadata(skillMd, deriveSkillNameFromPath(pointer.path));
  return {
    name: metadata.name,
    description: metadata.description,
    files,
    sourceType: "gitlab",
    sourceUrl,
    configJson: JSON.stringify({
      ...provenance,
      warnings,
      dependencies: parseSkillDependencyDeclarations(skillMd),
      requirements: parseSkillRequirementDeclarations(skillMd),
    }),
    warnings,
    resolvedRef,
    originalUrl: sourceUrl,
  };
}

async function importGitHubSkillDefinitionFromPointer(
  pointer: GitHubDirectoryPointer,
  sourceUrl: string,
  sourceType: SkillImportSourceType,
  workspaceId?: string,
): Promise<ImportedSkillDefinition> {
  const resolvedRef = pointer.resolvedSha;
  const provenance: Record<string, unknown> = {
    provider: sourceType,
    owner: pointer.owner,
    repo: pointer.repo,
    ref: pointer.ref,
    path: pointer.path,
  };
  if (resolvedRef) {
    provenance.resolvedRef = resolvedRef;
    provenance.originalUrl = sourceUrl;
  }

  if (pointer.path.endsWith("/SKILL.md") || sameValue(pointer.path, "SKILL.md")) {
    const skillMd = await fetchGitHubRawFile(pointer, workspaceId);
    const skillBytes = encodeUtf8(skillMd);
    assertSkillSourceFileBudget(
      { fileCount: 0, totalBytes: 0, requestCount: 0 },
      "SKILL.md",
      skillBytes,
      "GitHub skill",
    );
    const fallbackName = deriveSkillNameFromPath(pointer.path);
    const metadata = parseSkillMetadata(skillMd, fallbackName);
    return {
      name: metadata.name,
      description: metadata.description,
      files: [{ path: "SKILL.md", bytes: skillBytes }],
      sourceType,
      sourceUrl,
      configJson: JSON.stringify({
        ...provenance,
        dependencies: parseSkillDependencyDeclarations(skillMd),
        requirements: parseSkillRequirementDeclarations(skillMd),
      }),
      warnings: [],
      resolvedRef,
      resolvedPath: pointer.path,
      originalUrl: sourceUrl,
    };
  }

  const warnings: string[] = [];
  const files = pointer.discoveredFiles
    ? await fetchDiscoveredGitHubFiles(pointer, warnings, workspaceId)
    : await fetchGitHubDirectoryFiles(pointer, warnings, { workspaceId });
  const skillMd = readSkillMarkdown(files);
  const metadata = parseSkillMetadata(skillMd, deriveSkillNameFromPath(pointer.path));

  return {
    name: metadata.name,
    description: metadata.description,
    files,
    sourceType,
    sourceUrl,
    configJson: JSON.stringify({
      ...provenance,
      warnings,
      dependencies: parseSkillDependencyDeclarations(skillMd),
      requirements: parseSkillRequirementDeclarations(skillMd),
    }),
    warnings,
    resolvedRef,
    resolvedPath: pointer.path,
    originalUrl: sourceUrl,
  };
}

async function importSkillsShSkillDefinition(sourceUrl: string, parsedUrl: URL, workspaceId?: string): Promise<ImportedSkillDefinition> {
  const installPageResponse = await fetch(parsedUrl, {
    headers: {
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!installPageResponse.ok) {
    throw new Error(`Failed to fetch skills.sh page: ${installPageResponse.status}`);
  }
  const html = await readResponseTextWithLimit(
    installPageResponse,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "skills.sh page",
  );
  const fromCommand = parseSkillsShInstallCommand(html);
  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  const owner = fromCommand?.owner ?? pathParts[0];
  const repo = fromCommand?.repo ?? pathParts[1];
  const skillSlug = fromCommand?.skillSlug ?? pathParts[2];
  if (!owner || !repo || !skillSlug) {
    throw new Error("Could not resolve the skills.sh source repository.");
  }

  const ref = await fetchGitHubDefaultBranch(owner, repo, workspaceId);
  const pointer = await resolveGitHubSkillPointerBySlug({
    owner,
    repo,
    ref,
    skillSlug,
    workspaceId,
  });
  return importGitHubSkillDefinitionFromPointer(pointer, sourceUrl, "skills.sh", workspaceId);
}

async function importClawHubSkillDefinition(sourceUrl: string): Promise<ImportedSkillDefinition> {
  const pageResponse = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!pageResponse.ok) {
    throw new Error(`Failed to fetch ClawHub skill page: ${pageResponse.status}`);
  }
  const html = await readResponseTextWithLimit(
    pageResponse,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "ClawHub skill page",
  );
  const downloadUrl = extractClawHubDownloadUrl(html);
  if (!downloadUrl) {
    throw new Error("ClawHub skill page does not expose a downloadable package.");
  }

  const downloadResponse = await fetch(downloadUrl, {
    headers: {
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!downloadResponse.ok) {
    throw new Error(`Failed to download ClawHub skill: ${downloadResponse.status}`);
  }

  const archiveBytes = await readResponseBytesWithLimit(
    downloadResponse,
    MAX_SKILL_ARCHIVE_BYTES,
    "ClawHub skill archive",
  );
  const warnings: string[] = [];
  const files = readSkillZipFiles(archiveBytes, warnings, "ClawHub skill archive");
  let rawMetaJson: string | undefined;

  const filteredFiles: ImportedSkillFile[] = [];
  for (const file of files) {
    if (sameValue(file.path, "_meta.json")) {
      rawMetaJson = strFromU8(file.bytes);
      continue;
    }
    filteredFiles.push(file);
  }

  const skillMd = readSkillMarkdown(filteredFiles);
  const metadata = parseSkillMetadata(skillMd, deriveSkillNameFromPath(sourceUrl));
  return {
    name: metadata.name,
    description: metadata.description,
    files: filteredFiles,
    sourceType: "clawhub",
    sourceUrl,
    configJson: JSON.stringify({
      provider: "clawhub",
      downloadUrl,
      meta: parseJsonSafely(rawMetaJson),
      warnings,
    }),
    warnings,
  };
}

function parseGitHubDirectoryUrl(sourceUrl: string): GitHubDirectoryPointer | null {
  const parsed = parseUrl(sourceUrl);
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return null;
  }

  if (parsed.hostname === "github.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && (parts[2] === "tree" || parts[2] === "blob")) {
      const [owner, repo, _kind, ref, ...rest] = parts;
      return {
        owner,
        repo,
        ref,
        path: rest.join("/"),
      };
    }
  }

  if (parsed.hostname === "raw.githubusercontent.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 4) {
      const [owner, repo, ref, ...rest] = parts;
      return {
        owner,
        repo,
        ref,
        path: rest.join("/"),
      };
    }
  }

  return null;
}

function parseGitHubRepositoryUrl(sourceUrl: string): { owner: string; repo: string } | null {
  const parsed = parseUrl(sourceUrl);
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}

function parseGitLabDirectoryUrl(sourceUrl: string): GitLabDirectoryPointer | null {
  const parsed = parseUrl(sourceUrl);
  if (!parsed || parsed.hostname !== "gitlab.com") {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const separatorIndex = parts.indexOf("-");
  if (separatorIndex < 2 || separatorIndex + 3 > parts.length) {
    return null;
  }
  const kind = parts[separatorIndex + 1];
  if (kind !== "tree" && kind !== "blob" && kind !== "raw") {
    return null;
  }

  const projectSegments = parts.slice(0, separatorIndex);
  const rawRef = parts[separatorIndex + 2];
  if (!rawRef) {
    return null;
  }
  const repoIndex = projectSegments.length - 1;
  projectSegments[repoIndex] = projectSegments[repoIndex]!.replace(/\.git$/i, "");
  if (projectSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  try {
    return {
      projectPath: projectSegments.map((segment) => decodeURIComponent(segment)).join("/"),
      ref: decodeURIComponent(rawRef),
      path: parts.slice(separatorIndex + 3).map((segment) => decodeURIComponent(segment)).join("/"),
    };
  } catch {
    return null;
  }
}

async function readLocalSkillDirectoryFiles(
  directoryPath: string,
  warnings: string[],
  relativePrefix = "",
  requireSkillFile = true,
  budget: SkillSourceBudget = { fileCount: 0, totalBytes: 0, requestCount: 0 },
): Promise<ImportedSkillFile[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: ImportedSkillFile[] = [];

  for (const entry of entries) {
    const rawRelativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`Local skill directory contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const relativePath = pathResult.normalized;

    const absoluteEntryPath = resolve(directoryPath, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(absoluteEntryPath).catch(() => undefined);
      throw new Error(
        `Symlink "${relativePath}"${linkTarget ? ` -> "${linkTarget}"` : ""} is not allowed in skill packages.`,
      );
    }

    if (entry.isDirectory()) {
      files.push(...await readLocalSkillDirectoryFiles(absoluteEntryPath, warnings, relativePath, false, budget));
      continue;
    }

    if (!entry.isFile()) {
      warnings.push(`Skipped unsupported local entry: ${relativePath}`);
      continue;
    }

    const entryStats = await stat(absoluteEntryPath);
    const bytes = new Uint8Array(await readFile(absoluteEntryPath));
    assertSkillSourceFileBudget(budget, relativePath, bytes, "Local skill directory");
    files.push({
      path: relativePath,
      bytes,
      mode: (entryStats.mode & 0o777).toString(8),
    });
  }

  if (requireSkillFile && !files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error(`Local skill directory must contain SKILL.md: ${directoryPath}`);
  }

  return sortImportedSkillFiles(files);
}

async function readLocalSkillZipFiles(
  archivePath: string,
  warnings: string[],
): Promise<ImportedSkillFile[]> {
  return readSkillZipFiles(new Uint8Array(await readFile(archivePath)), warnings, "Local skill archive");
}

function readSkillZipFiles(
  archiveBytes: Uint8Array,
  warnings: string[],
  sourceLabel: string,
): ImportedSkillFile[] {
  if (archiveBytes.byteLength === 0) {
    throw new Error(`${sourceLabel} cannot be empty.`);
  }
  if (archiveBytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    throw new Error(`${sourceLabel} exceeds the ${MAX_SKILL_ARCHIVE_BYTES} byte upload limit.`);
  }
  assertZipCentralDirectoryBudgets(archiveBytes, sourceLabel);

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(archiveBytes);
  } catch {
    throw new Error(`${sourceLabel} is not a valid zip archive.`);
  }
  const entries = Object.entries(archive);
  if (entries.length > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_ARCHIVE_FILES} files.`);
  }

  const files: ImportedSkillFile[] = [];
  let uncompressedBytes = 0;
  let nestingDepth = 0;

  for (const [entryName, content] of entries) {
    const rawPath = classifySkillFilePath(entryName);
    if (!rawPath.ok) {
      throw new Error(`${sourceLabel} contains unsafe entry "${entryName}": ${rawPath.message}`);
    }
    const normalizedPath = rawPath.normalized;
    if (!normalizedPath) {
      continue;
    }
    const depth = normalizedPath.split("/").length;
    if (depth > nestingDepth) {
      nestingDepth = depth;
    }
    if (nestingDepth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
      throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
    }
    uncompressedBytes += content.byteLength;
    if (uncompressedBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`${sourceLabel} expands beyond the ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} byte extraction limit.`);
    }
    if (content.byteLength > MAX_SKILL_SINGLE_FILE_BYTES) {
      throw new Error(`${sourceLabel} entry "${normalizedPath}" exceeds the ${MAX_SKILL_SINGLE_FILE_BYTES} byte single-file limit.`);
    }
    files.push({
      path: normalizedPath,
      bytes: content,
    });
  }

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error(`${sourceLabel} must contain SKILL.md.`);
  }

  return sortImportedSkillFiles(files);
}

function assertZipCentralDirectoryBudgets(archiveBytes: Uint8Array, sourceLabel: string): void {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const minimumEocdBytes = 22;
  const searchStart = Math.max(0, archiveBytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = archiveBytes.byteLength - minimumEocdBytes; offset >= searchStart; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50
      && offset + minimumEocdBytes + view.getUint16(offset + 20, true) === archiveBytes.byteLength
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`${sourceLabel} has no valid zip central directory.`);

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw new Error(`${sourceLabel} uses an unsupported multi-disk or ZIP64 layout.`);
  }
  if (entryCount > MAX_SKILL_ARCHIVE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_ARCHIVE_FILES} files.`);
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset < 0 || centralEnd > eocdOffset || centralEnd > archiveBytes.byteLength) {
    throw new Error(`${sourceLabel} has an invalid zip central directory boundary.`);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`${sourceLabel} has an invalid zip central directory entry.`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const declaredBytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0 || declaredBytes === 0xffffffff || next > centralEnd) {
      throw new Error(`${sourceLabel} contains an encrypted, ZIP64, or truncated entry.`);
    }
    let entryName: string;
    try {
      entryName = decoder.decode(archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error(`${sourceLabel} contains a non-UTF-8 entry name.`);
    }
    const path = classifySkillFilePath(entryName);
    if (!path.ok) throw new Error(`${sourceLabel} contains unsafe entry "${entryName}": ${path.message}`);
    if (path.depth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
      throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
    }
    if (!entryName.endsWith("/") && declaredBytes > MAX_SKILL_SINGLE_FILE_BYTES) {
      throw new Error(`${sourceLabel} entry "${path.normalized}" declares more than ${MAX_SKILL_SINGLE_FILE_BYTES} uncompressed bytes.`);
    }
    declaredTotal += declaredBytes;
    if (declaredTotal > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`${sourceLabel} declares more than ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} uncompressed bytes.`);
    }
    cursor = next;
  }
  if (cursor !== centralEnd) throw new Error(`${sourceLabel} has trailing data inside its zip central directory.`);
}

function createUniqueImportSkillName(skills: WorkspaceSkill[], baseName: string): string {
  const trimmedBaseName = baseName.trim() || "新建 Skill";
  let candidate = trimmedBaseName;
  let counter = 2;
  while (
    isBuiltinSkill(candidate) ||
    skills.some((skill) => sameValue(skill.name, candidate))
  ) {
    candidate = `${trimmedBaseName} ${counter}`;
    counter += 1;
  }
  return candidate;
}

function parseSkillsShInstallCommand(html: string): { owner: string; repo: string; skillSlug: string } | null {
  const decodedHtml = decodeHtmlEntities(html);
  const match = decodedHtml.match(
    /npx skills add https:\/\/github\.com\/([^/\s"<']+)\/([^/\s"<']+)\s+--skill\s+(?:"([^"]+)"|'([^']+)'|([^<\s"']+))/i,
  );
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    skillSlug: match[3] ?? match[4] ?? match[5],
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

async function fetchGitHubDefaultBranch(owner: string, repo: string, workspaceId?: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to fetch GitHub repository metadata for ${owner}/${repo}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub repository metadata",
  ) as { default_branch?: string };
  return payload.default_branch?.trim() || "main";
}

async function resolveGitHubRefToSha(owner: string, repo: string, ref: string, workspaceId?: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to resolve GitHub ref "${ref}" for ${owner}/${repo}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub commit metadata",
  ) as { sha?: string };
  const sha = payload.sha?.trim().toLowerCase();
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error(`GitHub commit response did not contain a valid SHA for ref "${ref}".`);
  }
  return sha;
}

async function resolveGitLabRefToSha(
  projectPath: string,
  ref: string,
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<string> {
  assertSkillSourceRequestBudget(budget, "GitLab skill");
  const response = await fetch(
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}/repository/commits/${encodeURIComponent(ref)}`,
    {
      headers: {
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve GitLab ref "${ref}" to commit SHA: ${response.status}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitLab commit metadata",
  ) as { id?: string };
  const sha = payload.id?.trim().toLowerCase();
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error(`GitLab commit response did not contain a valid SHA for ref "${ref}".`);
  }
  return sha;
}

async function resolveGitHubSkillPointerBySlug(input: {
  owner: string;
  repo: string;
  ref: string;
  skillSlug: string;
  workspaceId?: string;
}): Promise<GitHubDirectoryPointer> {
  const resolvedSha = await resolveGitHubRefToSha(input.owner, input.repo, input.ref, input.workspaceId);
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/trees/${resolvedSha}?recursive=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(input.workspaceId ? gitAuthHeadersSync(input.workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to inspect GitHub repository tree for ${input.owner}/${input.repo}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SINGLE_FILE_BYTES,
    "GitHub repository tree",
  ) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const skillCandidates = (payload.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path!)
    .filter((path) => sameValue(basename(path), "SKILL.md"))
    .map((path) => path.slice(0, -"/SKILL.md".length))
    .filter((path) => path.split("/").some((segment) => sameSkillSlug(segment, input.skillSlug)))
    .sort((left, right) => left.length - right.length);

  const matchedPath = skillCandidates[0];
  if (!matchedPath) {
    throw new Error(`Could not find a skill directory for "${input.skillSlug}" in ${input.owner}/${input.repo}.`);
  }

  return {
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    path: matchedPath,
    resolvedSha,
  };
}

/**
 * Single GitHub source classification + SHA resolution path shared by the
 * import flow ({@link resolveGitHubSkillPointer}) and the update-check flow
 * ({@link resolveGitHubSourceSha}). A direct tree/blob/raw URL resolves its
 * own ref; a bare repository URL resolves the default branch first. Both
 * callers previously re-implemented this sequence — duplicated code that was
 * free to drift (a URL-classification or SHA-validation fix landing in one
 * flow silently missing the other). Returns `null` for non-GitHub URLs.
 */
async function resolveGitHubPointerWithSha(
  sourceUrl: string,
  workspaceId?: string,
): Promise<GitHubDirectoryPointer | null> {
  const directPointer = parseGitHubDirectoryUrl(sourceUrl);
  if (directPointer) {
    directPointer.resolvedSha = await resolveGitHubRefToSha(
      directPointer.owner,
      directPointer.repo,
      directPointer.ref,
      workspaceId,
    );
    return directPointer;
  }

  const repository = parseGitHubRepositoryUrl(sourceUrl);
  if (!repository) {
    return null;
  }
  const ref = await fetchGitHubDefaultBranch(repository.owner, repository.repo, workspaceId);
  const resolvedSha = await resolveGitHubRefToSha(repository.owner, repository.repo, ref, workspaceId);
  return {
    ...repository,
    ref,
    path: "",
    resolvedSha,
  };
}

async function resolveGitHubSkillPointer(
  sourceUrl: string,
  workspaceId?: string,
): Promise<GitHubDirectoryPointer | null> {
  // Direct tree/blob/raw URLs come back fully resolved (path included). Only a
  // bare repository URL needs skill discovery against the recursive tree.
  const base = await resolveGitHubPointerWithSha(sourceUrl, workspaceId);
  if (!base || base.path) {
    return base;
  }
  const repository = { owner: base.owner, repo: base.repo };
  const ref = base.ref;
  const resolvedSha = base.resolvedSha!;
  const response = await fetch(
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${resolvedSha}?recursive=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to inspect GitHub repository tree for ${repository.owner}/${repository.repo}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SINGLE_FILE_BYTES,
    "GitHub repository tree",
  ) as {
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; mode?: string; sha?: string; size?: number }>;
  };
  if (payload.truncated) {
    throw new SkillGitHubImportError(
      "skill.github.tree_truncated",
      `GitHub repository tree is too large to discover a unique skill safely in ${repository.owner}/${repository.repo}; use a tree URL for one skill directory.`,
    );
  }
  const treeEntries = payload.tree ?? [];
  const skillPaths = treeEntries
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path!)
    .filter((path) => sameValue(basename(path), "SKILL.md"))
    .map((path) => sameValue(path, "SKILL.md") ? "" : path.slice(0, -"/SKILL.md".length))
    .sort((left, right) => left.localeCompare(right));

  if (skillPaths.length === 0) {
    throw new SkillGitHubImportError(
      "skill.github.no_skill",
      `GitHub repository ${repository.owner}/${repository.repo} does not contain SKILL.md.`,
    );
  }
  if (skillPaths.length > 1) {
    // Fail closed with the candidate directories on the error payload — the
    // UI can offer a choice; until then the specific tree URL is the remedy.
    throw new SkillGitHubImportError(
      "skill.github.multiple_skills",
      `GitHub repository ${repository.owner}/${repository.repo} contains multiple skills; use a tree URL for one skill directory.`,
      { candidates: skillPaths },
    );
  }
  return {
    ...repository,
    ref,
    path: skillPaths[0]!,
    resolvedSha,
    discoveryRequestCount: 3,
    discoveredFiles: treeEntries
      .filter((entry): entry is { path: string; type?: string; mode?: string; sha?: string; size?: number } => (
        entry.type === "blob" && typeof entry.path === "string"
      ))
      .filter((entry) => {
        const prefix = skillPaths[0] ? `${skillPaths[0]}/` : "";
        return !prefix || entry.path.startsWith(prefix);
      })
      .map((entry) => ({
        path: entry.path,
        ...(entry.mode ? { mode: entry.mode } : {}),
        ...(entry.sha ? { sha: entry.sha } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      })),
  };
}

async function resolveGitHubSourceSha(sourceUrl: string, workspaceId?: string): Promise<string | null> {
  const resolved = await resolveGitHubPointerWithSha(sourceUrl, workspaceId);
  return resolved?.resolvedSha ?? null;
}

function sameSkillSlug(left: string, right: string): boolean {
  return normalizeSkillSlug(left) === normalizeSkillSlug(right);
}

function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/&amp;/g, "&")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchGitHubDirectoryFiles(
  pointer: GitHubDirectoryPointer,
  warnings: string[],
  options: {
    relativePrefix?: string;
    requireSkillFile?: boolean;
    budget?: SkillSourceBudget;
    workspaceId?: string;
  } = {},
): Promise<ImportedSkillFile[]> {
  const {
    relativePrefix = "",
    requireSkillFile = true,
    budget = { fileCount: 0, totalBytes: 0, requestCount: 0 },
    workspaceId,
  } = options;
  assertSkillSourceRequestBudget(budget, "GitHub skill");
  const ref = pointer.resolvedSha ?? pointer.ref;
  const contentsUrl = buildGitHubContentsApiUrl(pointer.owner, pointer.repo, pointer.path, ref);
  const response = await fetch(contentsUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
  });
  if (!response.ok) {
    throw skillGitHubHttpError(response, `Failed to fetch GitHub skill directory ${pointer.path || "/"}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub directory listing",
  ) as Array<{
    type?: string;
    name?: string;
    path?: string;
    download_url?: string | null;
    sha?: string;
    size?: number;
  }> | { type?: string };
  if (!Array.isArray(payload)) {
    throw new SkillGitHubImportError(
      "skill.github.no_skill",
      "GitHub URL must point to a directory that contains SKILL.md.",
    );
  }

  const files: ImportedSkillFile[] = [];
  for (const entry of payload) {
    if (!entry.path || !entry.name || !entry.type) {
      continue;
    }

    const rawRelativePath = joinRelative(relativePrefix, entry.name);
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitHub skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const relativePath = pathResult.normalized;

    if (entry.type === "dir") {
      const nestedPointer: GitHubDirectoryPointer = {
        ...pointer,
        path: entry.path,
      };
      files.push(...await fetchGitHubDirectoryFiles(nestedPointer, warnings, {
        relativePrefix: relativePath,
        requireSkillFile: false,
        budget,
        workspaceId,
      }));
      continue;
    }

    if (entry.type !== "file") {
      warnings.push(`Skipped unsupported GitHub entry: ${entry.path}`);
      continue;
    }

    assertSkillSourceRequestBudget(budget, "GitHub skill");
    const bytes = await fetchGitHubRawFileBytes(
      { ...pointer, path: entry.path },
      {
        workspaceId,
        fallbackBudget: budget,
        expectedBlobSha: entry.sha,
        expectedSize: entry.size,
      },
    );
    assertSkillSourceFileBudget(budget, relativePath, bytes, "GitHub skill");
    files.push({
      path: relativePath,
      bytes,
    });
  }

  if (requireSkillFile && !files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new SkillGitHubImportError("skill.github.no_skill", "Imported GitHub skill must contain SKILL.md.");
  }

  return sortImportedSkillFiles(files);
}

async function fetchDiscoveredGitHubFiles(
  pointer: GitHubDirectoryPointer,
  warnings: string[],
  workspaceId?: string,
): Promise<ImportedSkillFile[]> {
  const budget: SkillSourceBudget = {
    fileCount: 0,
    totalBytes: 0,
    requestCount: pointer.discoveryRequestCount ?? 0,
  };
  const prefix = pointer.path ? `${pointer.path.replace(/\/+$/, "")}/` : "";
  const downloadEntries: Array<{
    entry: { path: string; mode?: string; sha?: string; size?: number };
    relativePath: string;
  }> = [];

  for (const entry of pointer.discoveredFiles ?? []) {
    if (entry.mode && entry.mode !== "100644" && entry.mode !== "100755") {
      warnings.push(`Skipped unsupported GitHub entry: ${entry.path}`);
      continue;
    }
    if (prefix && !entry.path.startsWith(prefix)) {
      throw new Error(`GitHub repository tree returned an entry outside the selected skill path: ${entry.path}`);
    }
    const rawRelativePath = prefix ? entry.path.slice(prefix.length) : entry.path;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitHub skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }

    assertSkillSourceRequestBudget(budget, "GitHub skill");
    downloadEntries.push({
      entry,
      relativePath: pathResult.normalized,
    });
  }

  const files = await mapWithConcurrency(
    downloadEntries,
    GITHUB_RAW_DOWNLOAD_CONCURRENCY,
    async ({ entry, relativePath }) => {
      const bytes = await fetchGitHubRawFileBytes(
        { ...pointer, path: entry.path },
        {
          workspaceId,
          fallbackBudget: budget,
          expectedBlobSha: entry.sha,
          expectedSize: entry.size,
        },
      );
      assertSkillSourceFileBudget(budget, relativePath, bytes, "GitHub skill");
      return {
        path: relativePath,
        bytes,
        ...(entry.mode === "100755" ? { mode: "0755" } : entry.mode === "100644" ? { mode: "0644" } : {}),
      };
    },
  );

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error("Imported GitHub skill must contain SKILL.md.");
  }
  return sortImportedSkillFiles(files);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  if (failed) {
    throw firstError;
  }
  return results;
}

async function fetchGitLabDirectoryFiles(
  pointer: GitLabDirectoryPointer,
  warnings: string[],
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<ImportedSkillFile[]> {
  const ref = pointer.resolvedSha ?? pointer.ref;
  const entries: Array<{ type?: string; path?: string; mode?: string }> = [];
  let page = "1";

  while (page) {
    assertSkillSourceRequestBudget(budget, "GitLab skill");
    const query = new URLSearchParams({
      path: pointer.path,
      ref,
      recursive: "true",
      per_page: "100",
      page,
    });
    const response = await fetch(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(pointer.projectPath)}/repository/tree?${query}`,
      {
        headers: {
          "User-Agent": "DofeAgent/0.1.0",
          ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch GitLab skill directory: ${response.status}`);
    }
    const payload = await readResponseJsonWithLimit(
      response,
      MAX_SKILL_SOURCE_METADATA_BYTES,
      "GitLab directory listing",
    );
    if (!Array.isArray(payload)) {
      throw new Error("GitLab URL must point to a directory that contains SKILL.md.");
    }
    entries.push(...payload as Array<{ type?: string; path?: string; mode?: string }>);
    page = response.headers.get("x-next-page")?.trim() ?? "";
    if (page && !/^\d+$/.test(page)) {
      throw new Error("GitLab directory listing returned an invalid pagination cursor.");
    }
  }

  const blobEntries = entries.filter((entry) => entry.type === "blob" && typeof entry.path === "string");
  if (blobEntries.length > MAX_SKILL_PACKAGE_FILES) {
    throw new Error(`GitLab skill contains more than ${MAX_SKILL_PACKAGE_FILES} files.`);
  }

  const files: ImportedSkillFile[] = [];
  const prefix = pointer.path ? `${pointer.path.replace(/\/+$/, "")}/` : "";
  for (const entry of entries) {
    if (!entry.path || !entry.type || entry.type === "tree") {
      continue;
    }
    if (entry.type !== "blob") {
      warnings.push(`Skipped unsupported GitLab entry: ${entry.path}`);
      continue;
    }
    if (prefix && !entry.path.startsWith(prefix)) {
      throw new Error(`GitLab directory listing returned an entry outside the requested path: ${entry.path}`);
    }
    const rawRelativePath = prefix ? entry.path.slice(prefix.length) : entry.path;
    const pathResult = classifySkillFilePath(rawRelativePath);
    if (!pathResult.ok) {
      throw new Error(`GitLab skill contains unsafe path "${rawRelativePath}": ${pathResult.message}`);
    }
    const bytes = await fetchGitLabRawFile({ ...pointer, path: entry.path }, budget, workspaceId);
    assertSkillSourceFileBudget(budget, pathResult.normalized, bytes, "GitLab skill");
    files.push({
      path: pathResult.normalized,
      bytes,
      ...(entry.mode === "100755" ? { mode: "0755" } : entry.mode === "100644" ? { mode: "0644" } : {}),
    });
  }

  if (!files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error("Imported GitLab skill must contain SKILL.md.");
  }
  return sortImportedSkillFiles(files);
}

async function fetchGitLabRawFile(
  pointer: GitLabDirectoryPointer,
  budget: SkillSourceBudget,
  workspaceId?: string,
): Promise<Uint8Array> {
  assertSkillSourceRequestBudget(budget, "GitLab skill");
  const ref = pointer.resolvedSha ?? pointer.ref;
  const response = await fetch(
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(pointer.projectPath)}/repository/files/${encodeURIComponent(pointer.path)}/raw?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        "User-Agent": "DofeAgent/0.1.0",
        ...(workspaceId ? gitAuthHeadersSync(workspaceId, "gitlab.com") : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch GitLab skill file "${pointer.path}": ${response.status}`);
  }
  return readResponseBytesWithLimit(response, MAX_SKILL_SINGLE_FILE_BYTES, `GitLab skill file "${pointer.path}"`);
}

function assertSkillSourceRequestBudget(budget: SkillSourceBudget, sourceLabel: string): void {
  budget.requestCount += 1;
  if (budget.requestCount > MAX_SKILL_SOURCE_REQUESTS) {
    throw new Error(`${sourceLabel} requires more than ${MAX_SKILL_SOURCE_REQUESTS} remote requests.`);
  }
}

function assertSkillSourceFileBudget(
  budget: SkillSourceBudget,
  path: string,
  bytes: Uint8Array,
  sourceLabel: string,
): void {
  const pathResult = classifySkillFilePath(path);
  if (!pathResult.ok) {
    throw new Error(`${sourceLabel} contains unsafe path "${path}": ${pathResult.message}`);
  }
  if (pathResult.depth > MAX_SKILL_ARCHIVE_NESTING_DEPTH) {
    throw new Error(`${sourceLabel} exceeds ${MAX_SKILL_ARCHIVE_NESTING_DEPTH} levels of directory nesting.`);
  }
  if (bytes.byteLength > MAX_SKILL_SINGLE_FILE_BYTES) {
    throw new Error(`${sourceLabel} file "${path}" exceeds the ${MAX_SKILL_SINGLE_FILE_BYTES} byte single-file limit.`);
  }
  budget.fileCount += 1;
  budget.totalBytes += bytes.byteLength;
  if (budget.fileCount > MAX_SKILL_PACKAGE_FILES) {
    throw new Error(`${sourceLabel} contains more than ${MAX_SKILL_PACKAGE_FILES} files.`);
  }
  if (budget.totalBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new Error(`${sourceLabel} exceeds the ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES} byte total content limit.`);
  }
}

async function fetchGitHubRawFile(pointer: GitHubDirectoryPointer, workspaceId?: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await fetchGitHubRawFileBytes(pointer, { workspaceId }),
  );
}

async function fetchGitHubRawFileBytes(
  pointer: GitHubDirectoryPointer,
  options: {
    workspaceId?: string;
    fallbackBudget?: SkillSourceBudget;
    expectedBlobSha?: string;
    expectedSize?: number;
  } = {},
): Promise<Uint8Array> {
  const { workspaceId, fallbackBudget, expectedBlobSha, expectedSize } = options;
  const ref = pointer.resolvedSha ?? pointer.ref;
  let response: Response | undefined;
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/${pointer.owner}/${pointer.repo}/${ref}/${pointer.path}`,
      {
        headers: {
          "User-Agent": "DofeAgent/0.1.0",
          ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
        },
        signal: AbortSignal.timeout(GITHUB_RAW_DOWNLOAD_TIMEOUT_MS),
      },
    );
  } catch {
    response = undefined;
  }
  if (response?.ok) {
    const bytes = await readResponseBytesWithLimit(response, MAX_SKILL_SINGLE_FILE_BYTES, "GitHub skill file");
    if (matchesGitHubFileIntegrity(bytes, { expectedBlobSha, expectedSize })) {
      return bytes;
    }
  }

  if (fallbackBudget) {
    assertSkillSourceRequestBudget(fallbackBudget, "GitHub skill");
  }
  return fetchGitHubContentsFileBytes(pointer, workspaceId, { expectedBlobSha, expectedSize });
}

async function fetchGitHubContentsFileBytes(
  pointer: GitHubDirectoryPointer,
  workspaceId?: string,
  expected: { expectedBlobSha?: string; expectedSize?: number } = {},
): Promise<Uint8Array> {
  const ref = pointer.resolvedSha ?? pointer.ref;
  const response = await fetch(buildGitHubContentsApiUrl(pointer.owner, pointer.repo, pointer.path, ref), {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
      ...(workspaceId ? gitAuthHeadersSync(workspaceId, "github.com") : {}),
    },
    signal: AbortSignal.timeout(GITHUB_RAW_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    // The file was already enumerated in a SHA-locked tree, so a miss here is
    // a transfer failure (the raw fetch above failed too) — not "wrong URL".
    throw new SkillGitHubImportError(
      "skill.github.file_download_failed",
      `Failed to fetch GitHub skill file "${pointer.path}": ${response.status}`,
    );
  }
  const payload = await readResponseJsonWithLimit(
    response,
    Math.ceil(MAX_SKILL_SINGLE_FILE_BYTES * 1.5) + MAX_SKILL_SOURCE_METADATA_BYTES,
    `GitHub skill file "${pointer.path}"`,
  ) as {
    type?: string;
    encoding?: string;
    content?: string;
    sha?: string;
    size?: number;
  };
  if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`GitHub skill file "${pointer.path}" is not a supported file.`);
  }
  const bytes = new Uint8Array(Buffer.from(payload.content.replace(/\n/g, ""), "base64"));
  if (!matchesGitHubFileIntegrity(bytes, {
    expectedBlobSha: expected.expectedBlobSha ?? payload.sha,
    expectedSize: expected.expectedSize ?? payload.size,
  })) {
    throw new SkillGitHubImportError(
      "skill.github.file_download_failed",
      `GitHub skill file "${pointer.path}" did not match its immutable blob metadata.`,
    );
  }
  return bytes;
}

async function readResponseJsonWithLimit(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, maxBytes, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number, label: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readResponseBytesWithLimit(response, maxBytes, label),
  );
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new Error(`${label} returned an invalid Content-Length header.`);
    }
    if (declaredBytes > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maxBytes} byte download limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function buildGitHubContentsApiUrl(owner: string, repo: string, path: string, ref: string): string {
  const normalizedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const pathSuffix = normalizedPath ? `/${normalizedPath}` : "";
  return `https://api.github.com/repos/${owner}/${repo}/contents${pathSuffix}?ref=${encodeURIComponent(ref)}`;
}

function extractClawHubDownloadUrl(html: string): string | null {
  const match = html.match(/https:\/\/[^"']+convex\.site\/api\/v1\/download\?slug=[^"'<\s]+/i);
  return match ? match[0] : null;
}

function deriveSkillNameFromPath(path: string): string {
  const normalized = normalizeSkillFilePath(path);
  const segments = normalized.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - (sameValue(segments[segments.length - 1] ?? "", "SKILL.md") ? 2 : 1)] : "";
  return base || basename(path).replace(/\.md$/i, "") || "Imported Skill";
}

function readSkillMarkdown(files: ImportedSkillFile[]): string {
  const match = files.find((file) => sameValue(file.path, "SKILL.md"));
  if (!match) {
    throw new Error("Imported skill is missing required file \"SKILL.md\".");
  }
  return decodeUtf8(match.bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function encodeUtf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function matchesGitHubFileIntegrity(
  bytes: Uint8Array,
  expected: { expectedBlobSha?: string; expectedSize?: number },
): boolean {
  const expectedSize = expected.expectedSize;
  if (Number.isSafeInteger(expectedSize) && expectedSize !== undefined && expectedSize >= 0 && bytes.byteLength !== expectedSize) {
    return false;
  }
  const blobSha = expected.expectedBlobSha?.trim().toLowerCase();
  if (!blobSha || !/^[a-f0-9]{40}$/.test(blobSha)) {
    return true;
  }
  const actual = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  return actual === blobSha;
}

function joinRelative(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function sortImportedSkillFiles(files: ImportedSkillFile[]): ImportedSkillFile[] {
  return [...files].sort((left, right) => {
    if (sameValue(left.path, "SKILL.md")) {
      return -1;
    }
    if (sameValue(right.path, "SKILL.md")) {
      return 1;
    }
    return left.path.localeCompare(right.path, "en-US");
  });
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseJsonSafely(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readResolvedRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const resolvedRef = (value as Record<string, unknown>).resolvedRef;
  return typeof resolvedRef === "string" && /^[a-f0-9]{40}$/i.test(resolvedRef.trim())
    ? resolvedRef.trim().toLowerCase()
    : undefined;
}
