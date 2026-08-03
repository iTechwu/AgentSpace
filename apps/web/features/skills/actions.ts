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
  type SkillSourceUpdateInspection,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  infoToast,
  successToast,
  warningToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

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
}): Promise<ActionToastResult<{ skillId: string; renamed: boolean; replaced: boolean; skipped: boolean; requiresConfiguration: boolean }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(input.url, "skill import url");

  const result = await importWorkspaceSkillFromUrl({
    workspaceId: workspaceContext.currentWorkspace.id,
    url: input.url.trim(),
    conflict: input.conflict,
  });
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

  return actionToastResult({
    skillId: result.skillId,
    renamed: result.renamed,
    replaced: result.replaced,
    skipped: result.skipped,
    requiresConfiguration: result.requiresConfiguration,
  }, toast);
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
