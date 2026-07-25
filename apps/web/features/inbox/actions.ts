"use server";

import {
  archiveNotificationSync,
  markNotificationReadSync,
  readWorkspaceStateSync,
  sameValue,
  updateTaskStatusSync,
  type WorkspaceNotificationRecipient,
} from "@dofe-agent/services";
import type { TaskStatus } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

export async function updateInboxTaskStatusAction(taskId: string, status: TaskStatus): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  if (!taskId.trim()) {
    throw new Error("Missing task id.");
  }

  updateTaskStatusSync(taskId, status, workspaceContext.currentWorkspace.id);
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("任务状态已更新。", "Task status updated."),
    buildInboxTaskInvalidation(workspaceContext.currentWorkspace.id, taskId.trim()),
  );
}

export async function markInboxNotificationReadAction(notificationId: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const normalizedNotificationId = normalizeNotificationId(notificationId);
  const updated = mutateOwnedInboxNotification({
    workspaceId: workspaceContext.currentWorkspace.id,
    notificationId: normalizedNotificationId,
    currentUserId: workspaceContext.currentUser.id,
    mutate: markNotificationReadSync,
  });
  if (!updated) {
    throw new Error("notification.not_found");
  }
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("通知已标记已读。", "Notification marked read."),
    buildInboxNotificationInvalidation(workspaceContext.currentWorkspace.id),
  );
}

export async function archiveInboxNotificationAction(notificationId: string): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const normalizedNotificationId = normalizeNotificationId(notificationId);
  const updated = mutateOwnedInboxNotification({
    workspaceId: workspaceContext.currentWorkspace.id,
    notificationId: normalizedNotificationId,
    currentUserId: workspaceContext.currentUser.id,
    mutate: archiveNotificationSync,
  });
  if (!updated) {
    throw new Error("notification.not_found");
  }
  revalidateWorkspaceRoutes(workspaceContext.currentWorkspace.slug);
  return actionToastResult(
    undefined,
    successToast("通知已归档。", "Notification archived."),
    buildInboxNotificationInvalidation(workspaceContext.currentWorkspace.id),
  );
}

function normalizeNotificationId(value: string): string {
  const normalized = value.trim().replace(/^notification:/, "");
  if (!normalized) {
    throw new Error("Missing notification id.");
  }
  return normalized;
}

function mutateOwnedInboxNotification(input: {
  workspaceId: string;
  notificationId: string;
  currentUserId: string;
  mutate: (input: {
    workspaceId: string;
    notificationId: string;
    recipient: WorkspaceNotificationRecipient;
  }) => unknown;
}): unknown {
  const humanResult = input.mutate({
    workspaceId: input.workspaceId,
    notificationId: input.notificationId,
    recipient: {
      recipientType: "human",
      recipientId: input.currentUserId,
    },
  });
  if (humanResult) {
    return humanResult;
  }

  const ownedAgentNames = readWorkspaceStateSync(input.workspaceId).activeEmployees
    .filter((employee) => typeof employee.ownerUserId === "string" && sameValue(employee.ownerUserId, input.currentUserId))
    .map((employee) => employee.name);
  for (const agentName of ownedAgentNames) {
    const agentResult = input.mutate({
      workspaceId: input.workspaceId,
      notificationId: input.notificationId,
      recipient: {
        recipientType: "agent",
        recipientId: agentName,
      },
    });
    if (agentResult) {
      return agentResult;
    }
  }

  return null;
}

function revalidateWorkspaceRoutes(workspaceSlug: string): void {
  revalidateWorkspacePaths(workspaceSlug, ["/inbox", "/agents", "/im", "/market", "/task/board"]);
}

function buildInboxTaskInvalidation(workspaceId: string, taskId: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["inbox", "task-board", "agents", "im"],
    resources: [{ type: "task", id: taskId }],
    shell: "counters",
  };
}

function buildInboxNotificationInvalidation(workspaceId: string): WorkspaceInvalidationEvent {
  return {
    workspaceId,
    modules: ["inbox"],
    shell: "counters",
  };
}
