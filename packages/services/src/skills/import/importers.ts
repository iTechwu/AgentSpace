// 技能导入的各源（存储/本地/GitHub/GitLab/skills.sh/ClawHub）导入器（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { persistWorkspaceAttachmentFromBytesSync, readWorkspaceAttachmentBytesSync } from "../../attachments/attachments.ts";
import { sameValue } from "../../shared/helpers.ts";
import { parseSkillDependencyDeclarations } from "../dependencies.ts";
import { MAX_SKILL_ARCHIVE_BYTES } from "../package/archive-limits.ts";
import { parseSkillRequirementDeclarations } from "../requirements.ts";
import { parseSkillMetadata } from "../skill-metadata.ts";
import { strFromU8 } from "fflate";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fetchDiscoveredGitHubFiles, fetchGitHubDirectoryFiles } from "./fetch-github.ts";
import { assertSkillSourceFileBudget, fetchGitLabDirectoryFiles, fetchGitLabRawFile } from "./fetch-gitlab.ts";
import { fetchGitHubDefaultBranch, resolveGitHubSkillPointer, resolveGitHubSkillPointerBySlug, resolveGitLabRefToSha } from "./github-refs.ts";
import { deriveSkillNameFromPath, encodeUtf8, extractClawHubDownloadUrl, fetchGitHubRawFile, parseJsonSafely, parseUrl, readResponseBytesWithLimit, readResponseTextWithLimit, readSkillMarkdown } from "./http-shared.ts";
import { readLocalSkillDirectoryFiles, readLocalSkillZipFiles, readSkillZipFiles } from "./local-zip.ts";
import { parseSkillsShInstallCommand } from "./naming.ts";
import { parseGitLabDirectoryUrl } from "./source-parsers.ts";
import { MAX_SKILL_SOURCE_METADATA_BYTES, SkillGitHubImportError } from "./types.ts";
import type { GitHubDirectoryPointer, ImportedSkillDefinition, ImportedSkillFile, SkillImportSourceType, SkillSourceBudget } from "./types.ts";

export async function importSkillDefinition(
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
export function importStoredSkillDefinitionFromPath(
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
export function importStoredSkillDefinition(
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
export async function importLocalSkillDefinition(sourcePath: string): Promise<ImportedSkillDefinition> {
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
export async function importGitHubSkillDefinition(sourceUrl: string, workspaceId?: string): Promise<ImportedSkillDefinition> {
  const pointer = await resolveGitHubSkillPointer(sourceUrl, workspaceId);
  if (!pointer) {
    throw new SkillGitHubImportError(
      "skill.github.url_invalid",
      "Only GitHub repository, tree, blob, or raw skill URLs are supported.",
    );
  }
  return importGitHubSkillDefinitionFromPointer(pointer, sourceUrl, "github", workspaceId);
}
export async function importGitLabSkillDefinition(sourceUrl: string, workspaceId?: string): Promise<ImportedSkillDefinition> {
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
export async function importGitHubSkillDefinitionFromPointer(
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
export async function importSkillsShSkillDefinition(sourceUrl: string, parsedUrl: URL, workspaceId?: string): Promise<ImportedSkillDefinition> {
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
export async function importClawHubSkillDefinition(sourceUrl: string): Promise<ImportedSkillDefinition> {
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
