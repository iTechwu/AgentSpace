"use server";

import {
  assertCanUseEmployeeInChannelForActorSync,
  updateTaskStatusSync,
  reorderTaskSync,
  addTaskLabelSync,
  removeTaskLabelSync,
  estimateTaskSync,
  readWorkspaceStateSync,
} from "@dofe-agent/services";
import type { TaskEstimationResult } from "@dofe-agent/services";
import type { TaskStatus } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

export async function moveTaskToColumnAction(taskId: string, status: TaskStatus): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!taskId.trim()) {
    throw new Error("Missing task id.");
  }
  assertCanManageTaskForActor(
    taskId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentMembership.role,
  );
  updateTaskStatusSync(taskId, status, workspaceContext.currentWorkspace.id);
  revalidateTaskBoardRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("已更新", "Updated"),
    buildTaskBoardInvalidation(workspaceContext.currentWorkspace.id, taskId.trim()),
  );
}

export async function reorderTaskAction(taskId: string, sortOrder: number): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!taskId.trim()) {
    throw new Error("Missing task id.");
  }
  assertCanManageTaskForActor(
    taskId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentMembership.role,
  );
  reorderTaskSync(taskId, sortOrder, workspaceContext.currentWorkspace.id);
  revalidateTaskBoardRoutes(workspaceContext.currentWorkspace.slug);
}

export async function addTaskLabelAction(taskId: string, label: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!taskId.trim() || !label.trim()) {
    throw new Error("Missing task id or label.");
  }
  assertCanManageTaskForActor(
    taskId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentMembership.role,
  );
  addTaskLabelSync(taskId, label, workspaceContext.currentWorkspace.id);
  revalidateTaskBoardRoutes(workspaceContext.currentWorkspace.slug);
}

export async function removeTaskLabelAction(taskId: string, label: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!taskId.trim() || !label.trim()) {
    throw new Error("Missing task id or label.");
  }
  assertCanManageTaskForActor(
    taskId.trim(),
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    workspaceContext.currentUser.displayName,
    workspaceContext.currentMembership.role,
  );
  removeTaskLabelSync(taskId, label, workspaceContext.currentWorkspace.id);
  revalidateTaskBoardRoutes(workspaceContext.currentWorkspace.slug);
}

export async function estimateTaskAction(input: {
  taskTitle: string;
  taskDescription?: string;
  channelName?: string;
  candidateAgentIds?: string[];
}): Promise<TaskEstimationResult> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  return estimateTaskSync(input, workspaceContext.currentWorkspace.id);
}

function revalidateTaskBoardRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/task/board", "/inbox", "/agents"]);
}

function buildTaskBoardInvalidation(workspaceId: string, taskId: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["task-board", "inbox", "agents"],
    resources: [{ type: "task", id: taskId }],
    shell: "counters",
  };
}

function assertCanManageTaskForActor(
  taskId: string,
  workspaceId: string,
  actorUserId: string,
  actorDisplayName: string,
  actorRole: "owner" | "admin" | "member",
): void {
  const state = readWorkspaceStateSync(workspaceId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" does not exist.`);
  }
  assertCanUseEmployeeInChannelForActorSync({
    workspaceId,
    employeeName: task.assignee,
    channelName: task.channel,
    actorUserId,
    actorDisplayName,
    actorRole,
  });
}
