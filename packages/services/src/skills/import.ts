import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { getDatabase, recordStoredSkillImportEventSync, setActiveArtifactDigestForSkillSync, withTransaction } from "@dofe-agent/db";
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
import {
  deleteWorkspaceAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  readWorkspaceAttachmentBytesSync,
} from "../attachments/attachments.ts";
import {
  buildAndPersistSkillArtifactSync,
  isTextMediaType,
  mediaTypeForPath,
} from "./skill-artifacts.ts";
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

export type SkillImportConflict = "reject" | "rename" | "replace" | "skip";
export type SkillImportSourceType = "github" | "skills.sh" | "clawhub" | "local" | "tos";

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
  /** Immutable content-addressed artifact digest pinned to this skill (EAD-004). */
  artifactDigest?: string;
  warnings: string[];
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
}

// Extensions whose contents we additionally mirror into the text skill_file
// projection for backward compatibility. Binary files are NOT mirrored there —
// they live only in the immutable artifact. Nothing is skipped on import.
const TEXT_PROJECTION_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".js",
  ".mjs",
  ".ts",
  ".py",
  ".sh",
  ".html",
]);

export async function importWorkspaceSkillFromUrl(input: {
  workspaceId?: string;
  url: string;
  conflict?: SkillImportConflict;
}): Promise<SkillImportResult> {
  const workspaceId = input.workspaceId;
  const sourceUrl = input.url.trim();
  if (!sourceUrl) {
    throw new Error("Skill import URL is required.");
  }

  const hasRecordedStoredSource = listWorkspaceSkillsSync(workspaceId).some(
    (skill) => (skill.sourceType === "tos" || skill.sourceType === "local") && sameValue(skill.sourceUrl ?? "", sourceUrl),
  );
  const imported = await importSkillDefinition(sourceUrl, { hasRecordedStoredSource });
  return persistImportedSkillDefinition(imported, workspaceId, input.conflict);
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

  const updated = updateWorkspaceSkillSync({
    skillId: current.id,
    name: current.name,
    description: imported.description,
    sourceType: imported.sourceType,
    sourceUrl: imported.sourceUrl,
    configJson: imported.configJson,
  }, workspaceId);

  upsertTextProjectionFiles(updated.id, imported.files, workspaceId);

  const refreshed = readWorkspaceSkillSync(updated.id, workspaceId);
  if (!refreshed) {
    throw new Error(`Skill "${updated.id}" does not exist after import.`);
  }

  const importedPaths = new Set(imported.files.map((file) => file.path.toLocaleLowerCase("en-US")));
  for (const file of refreshed.files) {
    if (!importedPaths.has(file.path.toLocaleLowerCase("en-US")) && !sameValue(file.path, "SKILL.md")) {
      deleteWorkspaceSkillFileSync(refreshed.id, file.id, workspaceId);
    }
  }

  if (artifactDigest) {
    setActiveArtifactDigestForSkillSync({ skillId: refreshed.id, digest: artifactDigest, workspaceId });
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
    warnings: imported.warnings,
  };
}

function upsertTextProjectionFiles(skillId: string, files: ImportedSkillFile[], workspaceId: string): void {
  for (const file of files) {
    if (sameValue(file.path, "SKILL.md")) {
      continue;
    }
    if (!isTextProjectionPath(file.path)) {
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
  options: { hasRecordedStoredSource: boolean } = { hasRecordedStoredSource: false },
): Promise<ImportedSkillDefinition> {
  const parsed = parseUrl(sourceUrl);
  if (!parsed) {
    return importLocalSkillDefinition(sourceUrl);
  }

  if (parsed.hostname === "skills.sh") {
    return importSkillsShSkillDefinition(sourceUrl, parsed);
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
  return importGitHubSkillDefinition(sourceUrl);
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

async function importGitHubSkillDefinition(sourceUrl: string): Promise<ImportedSkillDefinition> {
  const pointer = parseGitHubDirectoryUrl(sourceUrl);
  if (!pointer) {
    throw new Error("Only GitHub tree/blob/raw skill URLs are supported for now.");
  }
  pointer.resolvedSha = await resolveGitHubRefToSha(pointer.owner, pointer.repo, pointer.ref);
  return importGitHubSkillDefinitionFromPointer(pointer, sourceUrl, "github");
}

async function importGitHubSkillDefinitionFromPointer(
  pointer: GitHubDirectoryPointer,
  sourceUrl: string,
  sourceType: SkillImportSourceType,
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
    const skillMd = await fetchGitHubRawFile(pointer);
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
      originalUrl: sourceUrl,
    };
  }

  const warnings: string[] = [];
  const files = await fetchGitHubDirectoryFiles(pointer, warnings);
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
    originalUrl: sourceUrl,
  };
}

async function importSkillsShSkillDefinition(sourceUrl: string, parsedUrl: URL): Promise<ImportedSkillDefinition> {
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

  const ref = await fetchGitHubDefaultBranch(owner, repo);
  const pointer = await resolveGitHubSkillPointerBySlug({
    owner,
    repo,
    ref,
    skillSlug,
  });
  return importGitHubSkillDefinitionFromPointer(pointer, sourceUrl, "skills.sh");
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
  if (!parsed) {
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

async function fetchGitHubDefaultBranch(owner: string, repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub repository metadata: ${response.status}`);
  }

  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub repository metadata",
  ) as { default_branch?: string };
  return payload.default_branch?.trim() || "main";
}

async function resolveGitHubRefToSha(owner: string, repo: string, ref: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve GitHub ref "${ref}" to commit SHA: ${response.status}`);
  }
  const payload = await readResponseJsonWithLimit(
    response,
    MAX_SKILL_SOURCE_METADATA_BYTES,
    "GitHub commit metadata",
  ) as { sha?: string };
  const sha = payload.sha?.trim().toLowerCase();
  if (!sha || sha.length !== 40) {
    throw new Error(`GitHub commit response did not contain a valid SHA for ref "${ref}".`);
  }
  return sha;
}

async function resolveGitHubSkillPointerBySlug(input: {
  owner: string;
  repo: string;
  ref: string;
  skillSlug: string;
}): Promise<GitHubDirectoryPointer> {
  const resolvedSha = await resolveGitHubRefToSha(input.owner, input.repo, input.ref);
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/git/trees/${resolvedSha}?recursive=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to inspect GitHub repository tree: ${response.status}`);
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
  relativePrefix = "",
  requireSkillFile = true,
  budget: SkillSourceBudget = { fileCount: 0, totalBytes: 0, requestCount: 0 },
): Promise<ImportedSkillFile[]> {
  assertSkillSourceRequestBudget(budget, "GitHub skill");
  const ref = pointer.resolvedSha ?? pointer.ref;
  const contentsUrl = buildGitHubContentsApiUrl(pointer.owner, pointer.repo, pointer.path, ref);
  const response = await fetch(contentsUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "DofeAgent/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub skill directory: ${response.status}`);
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
  }> | { type?: string };
  if (!Array.isArray(payload)) {
    throw new Error("GitHub URL must point to a directory that contains SKILL.md.");
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
      files.push(...await fetchGitHubDirectoryFiles(nestedPointer, warnings, relativePath, false, budget));
      continue;
    }

    if (entry.type !== "file") {
      warnings.push(`Skipped unsupported GitHub entry: ${entry.path}`);
      continue;
    }

    assertSkillSourceRequestBudget(budget, "GitHub skill");
    const fileResponse = await fetch(buildGitHubContentsApiUrl(pointer.owner, pointer.repo, entry.path, ref), {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "DofeAgent/0.1.0",
      },
    });
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch GitHub skill file: ${entry.path}`);
    }
    const filePayload = await readResponseJsonWithLimit(
      fileResponse,
      Math.ceil(MAX_SKILL_SINGLE_FILE_BYTES * 1.5) + MAX_SKILL_SOURCE_METADATA_BYTES,
      `GitHub skill file "${entry.path}"`,
    ) as {
      type?: string;
      encoding?: string;
      content?: string;
    };
    if (filePayload.type !== "file" || filePayload.encoding !== "base64" || typeof filePayload.content !== "string") {
      throw new Error(`GitHub skill file "${entry.path}" is not a supported file.`);
    }

    const bytes = new Uint8Array(Buffer.from(filePayload.content.replace(/\n/g, ""), "base64"));
    assertSkillSourceFileBudget(budget, relativePath, bytes, "GitHub skill");
    files.push({
      path: relativePath,
      bytes,
    });
  }

  if (requireSkillFile && !files.some((file) => sameValue(file.path, "SKILL.md"))) {
    throw new Error("Imported GitHub skill must contain SKILL.md.");
  }

  return sortImportedSkillFiles(files);
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

async function fetchGitHubRawFile(pointer: GitHubDirectoryPointer): Promise<string> {
  const ref = pointer.resolvedSha ?? pointer.ref;
  const response = await fetch(
    `https://raw.githubusercontent.com/${pointer.owner}/${pointer.repo}/${ref}/${pointer.path}`,
    { headers: { "User-Agent": "DofeAgent/0.1.0" } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub skill file: ${response.status}`);
  }
  return readResponseTextWithLimit(response, MAX_SKILL_SINGLE_FILE_BYTES, "GitHub skill file");
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
  return `https://api.github.com/repos/${owner}/${repo}/contents/${normalizedPath}?ref=${encodeURIComponent(ref)}`;
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

function isTextProjectionPath(path: string): boolean {
  if (sameValue(path, "SKILL.md")) {
    return true;
  }
  const normalized = path.toLowerCase();
  const extension = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".")) : "";
  if (TEXT_PROJECTION_EXTENSIONS.has(extension)) {
    return true;
  }
  return isTextMediaType(mediaTypeForPath(path));
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
