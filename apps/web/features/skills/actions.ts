"use server";

import { delimiter } from "node:path";
import {
  createWorkspaceSkillSync,
  deleteWorkspaceSkillFileSync,
  deleteWorkspaceSkillSync,
  exportWorkspaceSkillsArchiveSync,
  importWorkspaceSkillFromZipUpload,
  importWorkspaceSkillFromUrl,
  inspectWorkspaceSkillSourceUpdate,
  readWorkspaceSkillSync,
  tryRecordWorkspaceAuditEventSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
  SkillGitHubImportError,
  type SkillGitHubImportErrorCode,
  type SkillSourceUpdateInspection,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  errorToast,
  infoToast,
  successToast,
  warningToast,
  type ActionToastResult,
  type LocalizedToastDescriptor,
} from "@/shared/lib/toast-action";

/** Structured GitHub import failure returned (not thrown) so the UI can offer the matching remedy. */
export interface SkillImportActionError {
  code: SkillGitHubImportErrorCode;
  /** Candidate skill directories (multiple_skills); "" means the repository root. */
  candidates?: string[];
  /** Epoch seconds when the shared GitHub API quota resets (rate_limited). */
  retryAtEpochSeconds?: number;
}

export interface SkillImportActionData {
  skillId: string | null;
  renamed: boolean;
  replaced: boolean;
  skipped: boolean;
  requiresConfiguration: boolean;
  /** Resolved skill directory inside the repository ("" = repository root). */
  resolvedPath?: string;
  /** Immutable commit SHA the import was locked to (first 12 hex shown to users). */
  resolvedRef?: string;
  error?: SkillImportActionError;
}

/**
 * Localized message + remedy per stable GitHub import error code
 * (docs/0801/skill-install/14 §Implementation Decisions 的错误码表)。
 */
function describeSkillGitHubImportError(error: SkillGitHubImportError): LocalizedToastDescriptor {
  switch (error.code) {
    case "skill.github.url_invalid":
      return errorToast("无法识别该 GitHub 链接，请粘贴仓库、tree、blob 或 raw 链接。", "Unrecognized GitHub link; paste a repository, tree, blob, or raw URL.");
    case "skill.github.not_found":
      return errorToast("仓库或目录不存在，请检查链接与访问权限。", "Repository or directory not found; check the link and access.");
    case "skill.github.no_skill":
      return errorToast("仓库中未找到 SKILL.md，请使用包含 Skill 的仓库或目录链接。", "No SKILL.md found; use a repository or directory that contains one.");
    case "skill.github.multiple_skills": {
      const candidates = (error.candidates ?? [])
        .map((path) => path === "" ? "（仓库根目录）" : path)
        .join("、");
      return errorToast(
        candidates
          ? `仓库包含多个 Skill，请选择候选目录后用对应 tree 链接重新导入：${candidates}`
          : "仓库包含多个 Skill，请粘贴具体目录的 tree 链接重新导入。",
        "The repository contains multiple skills; pick one candidate directory and re-import with its tree URL.",
      );
    }
    case "skill.github.tree_truncated":
      return errorToast("仓库过大，无法安全自动定位 Skill，请粘贴具体目录的 tree 链接。", "Repository too large to locate a skill safely; paste a specific tree URL.");
    case "skill.github.rate_limited": {
      const retryAt = error.retryAtEpochSeconds !== undefined ? new Date(error.retryAtEpochSeconds * 1000) : null;
      const retryNote = retryAt && !Number.isNaN(retryAt.getTime())
        ? `（约 ${retryAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 后重试）`
        : "";
      return errorToast(
        `GitHub API 配额已用尽${retryNote}，可稍后重试，或在工作区配置 GitHub 凭据以使用独立配额。`,
        "GitHub API quota exhausted; retry later or configure a workspace GitHub credential.",
      );
    }
    case "skill.github.unauthorized":
      return errorToast("GitHub 凭据无权访问该仓库，请更新工作区 GitHub 凭据后重试。", "The workspace GitHub credential lacks access; update it and retry.");
    case "skill.github.file_download_failed":
      return errorToast("Skill 文件下载失败，请重试；若持续失败请检查网络与凭据。", "Skill file download failed; retry and check network/credentials.");
    default:
      return errorToast("GitHub 暂时不可用，请稍后重试。", "GitHub is temporarily unavailable; retry later.");
  }
}

export async function createWorkspaceSkillAction(input?: {
  name?: string;
  description?: string;
}): Promise<ActionToastResult<{ skillId: string; fileId: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const skill = createWorkspaceSkillSync({
    name: input?.name?.trim() || `new-skill-${Date.now().toString(36).slice(-4)}`,
    description: input?.description?.trim() || "",
  }, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill created",
    note: `Skill "${skill.name}" was created by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_created",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: skill.id,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  return actionToastResult(
    {
      skillId: skill.id,
      fileId: skill.files[0]?.id ?? "",
    },
    successToast("Skill 已创建。", "Skill created."),
  );
}

export async function updateWorkspaceSkillMetaAction(input: {
  skillId: string;
  name: string;
  description: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.name, "skill name");
  updateWorkspaceSkillSync({
    skillId: input.skillId.trim(),
    name: input.name.trim(),
    description: input.description,
  }, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill updated",
    note: `Skill "${input.name.trim()}" was updated by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_updated",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: input.skillId.trim(),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("Skill 元数据已保存。", "Skill metadata saved."));
}

export async function deleteWorkspaceSkillAction(skillId: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(skillId, "skill id");
  deleteWorkspaceSkillSync(skillId.trim(), workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill deleted",
    note: `Skill "${skillId.trim()}" was deleted by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_deleted",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: skillId.trim(),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("Skill 已删除。", "Skill deleted."));
}

export async function upsertWorkspaceSkillFileAction(input: {
  skillId: string;
  fileId?: string;
  path: string;
  content: string;
}): Promise<ActionToastResult<{ fileId: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.path, "file path");
  const file = upsertWorkspaceSkillFileSync({
    skillId: input.skillId.trim(),
    fileId: input.fileId?.trim() || undefined,
    path: input.path,
    content: input.content,
  }, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill file upserted",
    note: `Skill file "${input.path}" was saved by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_file_upserted",
    data: {
      actorType: "session_user",
      resourceType: "skill_file",
      resourceId: file.id,
      skillId: input.skillId.trim(),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    { fileId: file.id },
    successToast("Skill 文件已保存。", "Skill file saved."),
  );
}

export async function deleteWorkspaceSkillFileAction(input: {
  skillId: string;
  fileId: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.skillId, "skill id");
  assertRequired(input.fileId, "file id");
  deleteWorkspaceSkillFileSync(
    input.skillId.trim(),
    input.fileId.trim(),
    workspaceContext.currentWorkspace.id,
  );
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill file deleted",
    note: `Skill file "${input.fileId.trim()}" was deleted by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_file_deleted",
    data: {
      actorType: "session_user",
      resourceType: "skill_file",
      resourceId: input.fileId.trim(),
      skillId: input.skillId.trim(),
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(undefined, successToast("Skill 文件已删除。", "Skill file deleted."));
}

export async function importWorkspaceSkillFromUrlAction(input: {
  url: string;
  conflict?: "reject" | "rename" | "replace" | "skip";
}): Promise<ActionToastResult<SkillImportActionData>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.url, "skill import url");

  let result;
  try {
    result = await importWorkspaceSkillFromUrl({
      workspaceId: workspaceContext.currentWorkspace.id,
      url: input.url.trim(),
      conflict: input.conflict,
    });
  } catch (error) {
    // Stable product error codes surface as a NORMAL result (skillId=null +
    // error payload) so the UI can show the matching remedy instead of a raw
    // internal English exception; other errors keep propagating.
    if (error instanceof SkillGitHubImportError) {
      return actionToastResult(
        {
          skillId: null,
          renamed: false,
          replaced: false,
          skipped: false,
          requiresConfiguration: false,
          error: {
            code: error.code,
            ...(error.candidates ? { candidates: error.candidates } : {}),
            ...(error.retryAtEpochSeconds !== undefined ? { retryAtEpochSeconds: error.retryAtEpochSeconds } : {}),
          },
        },
        describeSkillGitHubImportError(error),
      );
    }
    throw error;
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill imported",
    note: `Skill "${result.skillName}" was imported by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_imported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: result.skillId,
      sourceType: result.sourceType,
      sourceUrl: input.url.trim(),
      renamed: result.renamed,
      replaced: result.replaced,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  const toast = result.skipped
    ? warningToast("Skill 已存在，本次导入已跳过。", "The skill already exists, so this import was skipped.")
    : result.replaced
      ? infoToast("Skill 已替换为导入版本。", "The skill was replaced with the imported version.")
      : result.renamed
        ? infoToast("Skill 已导入，并因重名自动重命名。", "Skill imported and auto-renamed due to a name conflict.")
        : successToast("Skill 已导入。", "Skill imported.");
  // Provenance summary: the user pasted a repository URL, so show WHICH
  // directory was resolved and WHICH commit the import is locked to.
  const provenanceSummary = result.resolvedRef
    ? result.resolvedPath
      ? `（来源目录 ${result.resolvedPath === "" ? "仓库根目录" : result.resolvedPath}，commit ${result.resolvedRef.slice(0, 12)}）`
      : `（commit ${result.resolvedRef.slice(0, 12)}）`
    : "";

  return actionToastResult({
    skillId: result.skillId,
    renamed: result.renamed,
    replaced: result.replaced,
    skipped: result.skipped,
    requiresConfiguration: result.requiresConfiguration,
    ...(result.resolvedPath !== undefined ? { resolvedPath: result.resolvedPath } : {}),
    ...(result.resolvedRef ? { resolvedRef: result.resolvedRef } : {}),
  }, provenanceSummary
    ? {
      ...toast,
      zh: `${toast.zh}${provenanceSummary}`,
      en: `${toast.en}${provenanceSummary}`,
    }
    : toast);
}

export async function importWorkspaceSkillFromServerDirectoryAction(input: {
  directoryPath: string;
  conflict?: "reject" | "rename" | "replace" | "skip";
}): Promise<ActionToastResult<{ skillId: string; renamed: boolean; replaced: boolean; skipped: boolean; requiresConfiguration: boolean }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.directoryPath, "server skill directory");
  const allowedFilesystemRoots = (process.env.DOFE_AGENT_SKILL_LOCAL_IMPORT_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  if (allowedFilesystemRoots.length === 0) {
    throw new Error("服务器尚未配置 Skill 本地导入根目录。");
  }

  const result = await importWorkspaceSkillFromUrl({
    workspaceId: workspaceContext.currentWorkspace.id,
    url: input.directoryPath.trim(),
    conflict: input.conflict,
    allowedFilesystemRoots,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill imported from server directory",
    note: `Skill "${result.skillName}" was imported from a server directory by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_imported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: result.skillId,
      sourceType: result.sourceType,
      sourceUrl: result.sourceUrl,
      renamed: result.renamed,
      replaced: result.replaced,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);

  const toast = result.skipped
    ? warningToast("Skill 已存在，本次导入已跳过。", "The skill already exists, so this import was skipped.")
    : result.replaced
      ? infoToast("Skill 已替换为服务器目录版本。", "The skill was replaced with the server directory version.")
      : result.renamed
        ? infoToast("Skill 已导入，并因重名自动重命名。", "Skill imported and auto-renamed due to a name conflict.")
        : successToast("已从服务器目录导入 Skill。", "Skill imported from the server directory.");

  return actionToastResult({
    skillId: result.skillId,
    renamed: result.renamed,
    replaced: result.replaced,
    skipped: result.skipped,
    requiresConfiguration: result.requiresConfiguration,
  }, toast);
}

export async function importWorkspaceSkillFromZipAction(formData: FormData): Promise<ActionToastResult<{ skillId: string; renamed: boolean; replaced: boolean; skipped: boolean; requiresConfiguration: boolean }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const archive = formData.get("archive");
  if (!archive || typeof archive === "string" || typeof archive.arrayBuffer !== "function") {
    throw new Error("请选择一个 Skill zip 文件。");
  }
  const conflict = formData.get("conflict");
  const result = await importWorkspaceSkillFromZipUpload({
    workspaceId: workspaceContext.currentWorkspace.id,
    fileName: archive.name,
    contentBytes: new Uint8Array(await archive.arrayBuffer()),
    conflict: conflict as "reject" | "rename" | "replace" | "skip",
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill imported",
    note: `Skill "${result.skillName}" was uploaded to TOS and imported by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_imported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: result.skillId,
      sourceType: result.sourceType,
      sourceUrl: result.sourceUrl,
      renamed: result.renamed,
      replaced: result.replaced,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    {
      skillId: result.skillId,
      renamed: result.renamed,
      replaced: result.replaced,
      skipped: result.skipped,
      requiresConfiguration: result.requiresConfiguration,
    },
    successToast("Skill 已上传至 TOS 并导入。", "Skill uploaded to TOS and imported."),
  );
}

export async function reimportWorkspaceSkillAction(skillId: string): Promise<ActionToastResult<{ skillId: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(skillId, "skill id");
  if (process.env.DOFE_SKILL_SOURCE_UPDATE_CHECKS_ENABLED?.trim().toLowerCase() === "false") {
    throw new Error("Skill source updates are temporarily frozen by platform operations.");
  }

  const skill = readWorkspaceSkillSync(skillId.trim(), workspaceContext.currentWorkspace.id);
  if (!skill) {
    throw new Error(`Skill "${skillId.trim()}" does not exist.`);
  }
  if (!skill.sourceUrl || !skill.sourceType || skill.sourceType === "manual" || skill.sourceType === "builtin") {
    throw new Error("This skill does not have a reusable import source.");
  }

  const result = await importWorkspaceSkillFromUrl({
    workspaceId: workspaceContext.currentWorkspace.id,
    url: skill.sourceUrl,
    conflict: "replace",
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skill reimported",
    note: `Skill "${skill.name}" was reimported by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.skill_reimported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: result.skillId,
      sourceType: skill.sourceType,
      sourceUrl: skill.sourceUrl,
    },
  });
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    {
      skillId: result.skillId,
    },
    infoToast("来源已重新导入；如内容有变化，候选版本已生成。", "Source reimported; a candidate was created if the content changed."),
  );
}

export async function checkWorkspaceSkillSourceUpdateAction(
  skillId: string,
): Promise<ActionToastResult<SkillSourceUpdateInspection>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(skillId, "skill id");

  const inspection = await inspectWorkspaceSkillSourceUpdate({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: skillId.trim(),
  });
  if (inspection.status === "update_available") {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: "Skill source update detected",
      note: `${workspaceContext.currentUser.displayName} detected a source update for skill "${skillId.trim()}".`,
      code: "workspace.skill_source_update_detected",
      data: {
        actorType: "session_user",
        resourceType: "skill",
        resourceId: skillId.trim(),
        sourceType: inspection.sourceType,
        currentResolvedRef: inspection.currentResolvedRef,
        latestResolvedRef: inspection.latestResolvedRef,
      },
    });
  }

  const toast = inspection.status === "update_available"
    ? infoToast("检测到新版本，可获取为候选版本后审查发布。", "A new version is available. Fetch it as a candidate for review.")
    : inspection.status === "up_to_date"
      ? successToast("当前已是来源的最新版本。", "This skill is up to date with its source.")
      : inspection.status === "disabled"
        ? warningToast("平台运维已暂时冻结来源更新。", "Source updates are temporarily frozen by platform operations.")
        : warningToast("当前来源无法自动检查更新。", "This source cannot be checked automatically.");
  return actionToastResult(inspection, toast);
}

export async function exportWorkspaceSkillsAction(input: {
  skillIds: string[];
}): Promise<{ fileName: string; archiveBase64: string }> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  if (!Array.isArray(input.skillIds) || input.skillIds.length === 0) {
    throw new Error("At least one skill must be selected for export.");
  }

  const archive = exportWorkspaceSkillsArchiveSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillIds: input.skillIds,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Skills exported",
    note: `${workspaceContext.currentUser.displayName} exported ${input.skillIds.length} skill(s).`,
    code: "workspace.skills_exported",
    data: {
      actorType: "session_user",
      resourceType: "skill",
      resourceId: input.skillIds.join(","),
    },
  });
  return {
    fileName: archive.fileName,
    archiveBase64: Buffer.from(archive.zipBytes).toString("base64"),
  };
}

function assertRequired(value: string | undefined, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${label}.`);
  }
}

function revalidateWorkspaceRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/agents", "/skills"]);
}
