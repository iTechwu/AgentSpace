"use server";

import {
  createWorkspaceSkillSync,
  deleteWorkspaceSkillFileSync,
  deleteWorkspaceSkillSync,
  exportWorkspaceSkillsArchiveSync,
  importWorkspaceSkillFromUrl,
  readWorkspaceSkillSync,
  tryRecordWorkspaceAuditEventSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
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
}): Promise<ActionToastResult<{ skillId: string; renamed: boolean; replaced: boolean; skipped: boolean }>> {
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
  }, toast);
}

export async function reimportWorkspaceSkillAction(skillId: string): Promise<ActionToastResult<{ skillId: string }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  assertRequired(skillId, "skill id");

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
    infoToast("Skill 已按来源重新导入。", "Skill reimported from its source."),
  );
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
