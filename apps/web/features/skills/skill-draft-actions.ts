"use server";

import {
  discardSkillDraftSync,
  hasSkillDraftSync,
  publishSkillDraftSync,
  readSkillDraftSync,
  saveSkillDraftSync,
  type SkillDraftView,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  infoToast,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

/** Server-side skill draft (P1-3): stage edits without touching the live skill. */
export async function saveSkillDraftAction(input: {
  skillId: string;
  name: string;
  description?: string;
  files: Array<{ path: string; content: string }>;
}): Promise<ActionToastResult<SkillDraftView>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const view = saveSkillDraftSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
    name: input.name,
    description: input.description,
    files: input.files,
    actorUserId: workspaceContext.currentUser.id,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/skills"]);
  return actionToastResult(
    view,
    infoToast("草稿已保存。", "Draft saved."),
  );
}

export async function readSkillDraftAction(input: {
  skillId: string;
}): Promise<SkillDraftView | null> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return readSkillDraftSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
  });
}

export async function hasSkillDraftAction(input: {
  skillId: string;
}): Promise<boolean> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return hasSkillDraftSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
  });
}

export async function publishSkillDraftAction(input: {
  skillId: string;
}): Promise<ActionToastResult<SkillDraftView>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const view = publishSkillDraftSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    actorDisplayName: workspaceContext.currentUser.displayName,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/skills"]);
  return actionToastResult(
    view,
    successToast("草稿已发布到线上 Skill。", "Draft published to the live skill."),
  );
}

export async function discardSkillDraftAction(input: {
  skillId: string;
}): Promise<ActionToastResult<{ discarded: boolean }>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const discarded = discardSkillDraftSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    skillId: input.skillId.trim(),
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/skills"]);
  return actionToastResult(
    { discarded },
    infoToast("草稿已丢弃。", "Draft discarded."),
  );
}
