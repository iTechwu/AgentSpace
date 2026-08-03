import {
  deleteSkillDraftSync as deleteStoredSkillDraftSync,
  readSkillDraftSync as readStoredSkillDraftSync,
  upsertSkillDraftSync,
  type SkillDraftSnapshot,
} from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import {
  deleteWorkspaceSkillFileSync,
  readWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
} from "./skills.ts";

/**
 * Server-side skill drafts (P1-3): admins stage a skill's name/description/files
 * without affecting the live skill, then publish the draft in one atomic step.
 * The draft snapshot is stored server-side and never touches the live rows until
 * publish.
 */

export interface SkillDraftView {
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
  updatedAt: string;
}

export function saveSkillDraftSync(input: {
  workspaceId: string;
  skillId: string;
  name: string;
  description?: string;
  files: Array<{ path: string; content: string }>;
  actorUserId?: string;
}): SkillDraftView {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Skill draft name is required.");
  }
  if (!input.files.some((file) => file.path === "SKILL.md")) {
    throw new Error("Skill draft must contain SKILL.md.");
  }
  const snapshot: SkillDraftSnapshot = {
    name,
    description: input.description?.trim() ?? "",
    files: input.files.map((file) => ({ path: file.path, content: file.content })),
  };
  const record = upsertSkillDraftSync({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    draftJson: JSON.stringify(snapshot),
    updatedByUserId: input.actorUserId,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Skill draft saved",
    note: `Draft for skill "${input.skillId}" was saved.`,
    code: "workspace.skill_draft_saved",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "skill",
      resourceId: input.skillId,
    },
  });
  return { ...snapshot, updatedAt: record.updatedAt };
}

export function readSkillDraftSync(input: {
  workspaceId: string;
  skillId: string;
}): SkillDraftView | null {
  const record = readStoredSkillDraftSync(input.skillId, input.workspaceId);
  if (!record) {
    return null;
  }
  const snapshot = parseDraftSnapshot(record.draftJson);
  return snapshot ? { ...snapshot, updatedAt: record.updatedAt } : null;
}

export function hasSkillDraftSync(input: { workspaceId: string; skillId: string }): boolean {
  return readStoredSkillDraftSync(input.skillId, input.workspaceId) !== null;
}

/** Applies the draft to the live skill, then clears the draft. */
export function publishSkillDraftSync(input: {
  workspaceId: string;
  skillId: string;
  actorUserId?: string;
  actorDisplayName?: string;
}): SkillDraftView {
  const record = readStoredSkillDraftSync(input.skillId, input.workspaceId);
  if (!record) {
    throw new Error("没有可发布的草稿。");
  }
  const snapshot = parseDraftSnapshot(record.draftJson);
  if (!snapshot) {
    throw new Error("草稿内容不可读。");
  }
  const skill = readWorkspaceSkillSync(input.skillId, input.workspaceId);
  if (!skill) {
    throw new Error("Skill 不存在。");
  }
  updateWorkspaceSkillSync({
    skillId: input.skillId,
    name: snapshot.name,
    description: snapshot.description,
  }, input.workspaceId);
  const existingByPath = new Map(skill.files.map((file) => [file.path, file]));
  const draftPaths = new Set(snapshot.files.map((file) => file.path));
  for (const file of snapshot.files) {
    upsertWorkspaceSkillFileSync({
      skillId: input.skillId,
      fileId: existingByPath.get(file.path)?.id,
      path: file.path,
      content: file.content,
    }, input.workspaceId);
  }
  for (const [path, file] of existingByPath) {
    if (!draftPaths.has(path) && path !== "SKILL.md") {
      deleteWorkspaceSkillFileSync(input.skillId, file.id, input.workspaceId);
    }
  }
  deleteStoredSkillDraftSync(input.skillId, input.workspaceId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Skill draft published",
    note: `Draft for skill "${input.skillId}" was published${input.actorDisplayName ? ` by ${input.actorDisplayName}` : ""}.`,
    code: "workspace.skill_draft_published",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "skill",
      resourceId: input.skillId,
    },
  });
  return { ...snapshot, updatedAt: record.updatedAt };
}

export function discardSkillDraftSync(input: {
  workspaceId: string;
  skillId: string;
}): boolean {
  return deleteStoredSkillDraftSync(input.skillId, input.workspaceId);
}

function parseDraftSnapshot(json: string): SkillDraftSnapshot | null {
  try {
    const parsed = JSON.parse(json) as Partial<SkillDraftSnapshot>;
    if (
      typeof parsed.name !== "string" ||
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file) => typeof file?.path === "string" && typeof file?.content === "string")
    ) {
      return null;
    }
    return {
      name: parsed.name,
      description: typeof parsed.description === "string" ? parsed.description : "",
      files: parsed.files.map((file) => ({ path: file.path, content: file.content })),
    };
  } catch {
    return null;
  }
}
