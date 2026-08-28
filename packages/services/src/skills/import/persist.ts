// 技能导入的导入结果持久化与提交（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { normalizeSkillFilePath, sameValue } from "../../shared/helpers.ts";
import { validateSkillPackage } from "../package/package-validator.ts";
import type { SkillPackageInputFile } from "../package/package-validator.ts";
import { classifySkillFile } from "../package/skill-file-policy.ts";
import { parseSkillRequirementDeclarations } from "../requirements.ts";
import { buildAndPersistSkillArtifactSync } from "../skill-artifacts.ts";
import { createWorkspaceSkillSync, deleteWorkspaceSkillFileSync, isBuiltinSkill, listWorkspaceSkillsSync, readWorkspaceSkillSync, updateWorkspaceSkillSync, upsertWorkspaceSkillFileSync } from "../skills.ts";
import { getDatabase, readActiveArtifactDigestForSkillSync, recordStoredSkillImportEventSync, setActiveArtifactDigestForSkillSync, upsertSkillArtifactBindingSync, withTransaction } from "@dofe-agent/db";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { decodeUtf8, parseJsonSafely, readSkillMarkdown } from "./http-shared.ts";
import { createUniqueImportSkillName } from "./naming.ts";
import { parseGitHubDirectoryUrl, parseGitHubRepositoryUrl, parseGitLabDirectoryUrl } from "./source-parsers.ts";
import type { ImportedSkillDefinition, ImportedSkillFile, SkillImportConflict, SkillImportResult } from "./types.ts";

export async function persistImportedSkillDefinition(
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
export function commitCreatedSkillImport(
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
export function commitReplacedSkillImport(
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
export function upsertTextProjectionFiles(skillId: string, files: ImportedSkillFile[], workspaceId: string): void {
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

/**
 * Validates the package and persists the immutable content-addressed artifact
 * from the full file set (text + binary). The resulting digest is pinned on the
 * skill row inside the same transaction that commits the Skill. Per EAD-004:
 * every declared file — including scripts and binary resources — must be present;
 * a manifest that omits files cannot represent a "successful" import.
 */
export function prepareSkillArtifact(
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
      ...(manifest?.skillDependencies ? { skillDependencies: manifest.skillDependencies } : {}),
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
