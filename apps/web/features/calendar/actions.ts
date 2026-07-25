"use server";

import {
  createScheduledTaskSync,
  updateScheduledTaskSync,
  toggleScheduledTaskSync,
  deleteScheduledTaskSync,
} from "@dofe-agent/services";
import type { ScheduledTask } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";

export async function createScheduledTaskAction(input: {
  title: string;
  description?: string;
  assignee?: string;
  channelName?: string;
  repeat: ScheduledTask["repeat"];
  cronExpression?: string;
  scheduledAt: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createScheduledTaskSync(input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/calendar", workspaceContext.currentWorkspace.slug);
}

export async function updateScheduledTaskAction(
  id: string,
  input: {
    title?: string;
    description?: string;
    assignee?: string;
    channelName?: string;
    repeat?: ScheduledTask["repeat"];
    cronExpression?: string;
    scheduledAt?: string;
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateScheduledTaskSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/calendar", workspaceContext.currentWorkspace.slug);
}

export async function toggleScheduledTaskAction(
  id: string,
  status: "active" | "paused",
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  toggleScheduledTaskSync(id, status, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/calendar", workspaceContext.currentWorkspace.slug);
}

export async function deleteScheduledTaskAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteScheduledTaskSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/calendar", workspaceContext.currentWorkspace.slug);
}
