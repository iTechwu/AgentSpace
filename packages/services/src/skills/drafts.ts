import {
  deleteSkillDraftPrismaCutover,
  deleteSkillDraftSync as deleteStoredSkillDraftSync,
  readSkillDraftSync as readStoredSkillDraftSync,
  upsertSkillDraftPrismaCutover,
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
  const { snapshot, draftJson } = buildDraftSnapshot(input);
  const record = upsertSkillDraftSync({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    draftJson,
    updatedByUserId: input.actorUserId,
  });
  recordSkillDraftSavedAudit(input.workspaceId, input.skillId, input.actorUserId);
  return { ...snapshot, updatedAt: record.updatedAt };
}

/** Prisma 写 cutover：flag OFF 走 sync fallback，行为与 sync 变体一致。 */
export async function saveSkillDraftAsync(input: {
  workspaceId: string;
  skillId: string;
  name: string;
  description?: string;
  files: Array<{ path: string; content: string }>;
  actorUserId?: string;
}): Promise<SkillDraftView> {
  const { snapshot, draftJson } = buildDraftSnapshot(input);
  const record = await upsertSkillDraftPrismaCutover({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    draftJson,
    updatedByUserId: input.actorUserId,
  });
  recordSkillDraftSavedAudit(input.workspaceId, input.skillId, input.actorUserId);
  return { ...snapshot, updatedAt: record.updatedAt };
}

function buildDraftSnapshot(input: {
  name: string;
  description?: string;
  files: Array<{ path: string; content: string }>;
}): { snapshot: SkillDraftSnapshot; draftJson: string } {
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
  return { snapshot, draftJson: JSON.stringify(snapshot) };
}

function recordSkillDraftSavedAudit(workspaceId: string, skillId: string, actorUserId?: string): void {
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Skill draft saved",
    note: `Draft for skill "${skillId}" was saved.`,
    code: "workspace.skill_draft_saved",
    data: {
      actorType: "session_user",
      actorUserId,
      resourceType: "skill",
      resourceId: skillId,
    },
  });
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
  const { snapshot, updatedAt } = readDraftForPublish(input.workspaceId, input.skillId);
  applyDraftSnapshotToLiveSkill(input.workspaceId, input.skillId, snapshot);
  deleteStoredSkillDraftSync(input.skillId, input.workspaceId);
  recordSkillDraftPublishedAudit(input.workspaceId, input.skillId, input.actorUserId, input.actorDisplayName);
  return { ...snapshot, updatedAt };
}

/** Prisma 写 cutover（草稿清除一步）：flag OFF 走 sync fallback，行为与 sync 变体一致。 */
export async function publishSkillDraftAsync(input: {
  workspaceId: string;
  skillId: string;
  actorUserId?: string;
  actorDisplayName?: string;
}): Promise<SkillDraftView> {
  const { snapshot, updatedAt } = readDraftForPublish(input.workspaceId, input.skillId);
  applyDraftSnapshotToLiveSkill(input.workspaceId, input.skillId, snapshot);
  await deleteSkillDraftPrismaCutover({ workspaceId: input.workspaceId, skillId: input.skillId });
  recordSkillDraftPublishedAudit(input.workspaceId, input.skillId, input.actorUserId, input.actorDisplayName);
  return { ...snapshot, updatedAt };
}

function readDraftForPublish(workspaceId: string, skillId: string): { snapshot: SkillDraftSnapshot; updatedAt: string } {
  const record = readStoredSkillDraftSync(skillId, workspaceId);
  if (!record) {
    throw new Error("没有可发布的草稿。");
  }
  const snapshot = parseDraftSnapshot(record.draftJson);
  if (!snapshot) {
    throw new Error("草稿内容不可读。");
  }
  if (!readWorkspaceSkillSync(skillId, workspaceId)) {
    throw new Error("Skill 不存在。");
  }
  return { snapshot, updatedAt: record.updatedAt };
}

function applyDraftSnapshotToLiveSkill(workspaceId: string, skillId: string, snapshot: SkillDraftSnapshot): void {
  const skill = readWorkspaceSkillSync(skillId, workspaceId);
  if (!skill) {
    throw new Error("Skill 不存在。");
  }
  updateWorkspaceSkillSync({
    skillId,
    name: snapshot.name,
    description: snapshot.description,
  }, workspaceId);
  const existingByPath = new Map(skill.files.map((file) => [file.path, file]));
  const draftPaths = new Set(snapshot.files.map((file) => file.path));
  for (const file of snapshot.files) {
    upsertWorkspaceSkillFileSync({
      skillId,
      fileId: existingByPath.get(file.path)?.id,
      path: file.path,
      content: file.content,
    }, workspaceId);
  }
  for (const [path, file] of existingByPath) {
    if (!draftPaths.has(path) && path !== "SKILL.md") {
      deleteWorkspaceSkillFileSync(skillId, file.id, workspaceId);
    }
  }
}

function recordSkillDraftPublishedAudit(
  workspaceId: string,
  skillId: string,
  actorUserId?: string,
  actorDisplayName?: string,
): void {
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Skill draft published",
    note: `Draft for skill "${skillId}" was published${actorDisplayName ? ` by ${actorDisplayName}` : ""}.`,
    code: "workspace.skill_draft_published",
    data: {
      actorType: "session_user",
      actorUserId,
      resourceType: "skill",
      resourceId: skillId,
    },
  });
}

export function discardSkillDraftSync(input: {
  workspaceId: string;
  skillId: string;
}): boolean {
  return deleteStoredSkillDraftSync(input.skillId, input.workspaceId);
}

/** Prisma 写 cutover：flag OFF 走 sync fallback，行为与 sync 变体一致。 */
export async function discardSkillDraftAsync(input: {
  workspaceId: string;
  skillId: string;
}): Promise<boolean> {
  return deleteSkillDraftPrismaCutover({ workspaceId: input.workspaceId, skillId: input.skillId });
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
