// 技能导入的技能导入/更新检查公共入口（从 src/skills/import.ts 拆出，3.6 巨型文件项）。

import { deleteWorkspaceAttachmentsSync, persistWorkspaceAttachmentFromBytesSync, readWorkspaceAttachmentBytesSync } from "../../attachments/attachments.ts";
import { notifyWorkspaceAdminsSync } from "../../notifications/notifications.ts";
import { sameValue } from "../../shared/helpers.ts";
import { resolveWorkspaceGitCredentialSecretSync } from "../git-credentials.ts";
import { MAX_SKILL_ARCHIVE_BYTES } from "../package/archive-limits.ts";
import { listWorkspaceSkillsSync, readWorkspaceSkillSync } from "../skills.ts";
import { listSkillArtifactBindingsForSkillSync, listStoredWorkspaceSkillsSync, readActiveArtifactDigestForSkillSync, readSkillArtifactByDigestSync } from "@dofe-agent/db";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitHubSourceSha, resolveGitLabRefToSha } from "./github-refs.ts";
import { parseJsonSafely, parseUrl, readResolvedRef } from "./http-shared.ts";
import { importSkillDefinition, importStoredSkillDefinition } from "./importers.ts";
import { persistImportedSkillDefinition } from "./persist.ts";
import { parseGitLabDirectoryUrl } from "./source-parsers.ts";
import type { SkillImportConflict, SkillImportResult, SkillSourceUpdateInspection } from "./types.ts";

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
export async function resolveAllowedFilesystemSkillSource(sourcePath: string, allowedRoots: string[]): Promise<string> {
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
