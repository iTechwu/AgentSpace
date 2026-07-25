import type { DofeAgentState, ScheduledTask } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { createOpaqueId } from "../shared/helpers.ts";

export function listScheduledTasksSync(workspaceId?: string): ScheduledTask[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  return state.scheduledTasks ?? [];
}

export function readScheduledTaskSync(id: string, workspaceId?: string): ScheduledTask | undefined {
  const state = ensureWorkspaceStateSync(workspaceId);
  return (state.scheduledTasks ?? []).find((task) => task.id === id);
}

export function createScheduledTaskSync(input: {
  title: string;
  description?: string;
  assignee?: string;
  channelName?: string;
  repeat: ScheduledTask["repeat"];
  cronExpression?: string;
  scheduledAt: string;
  createdBy?: string;
}, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const title = input.title.trim();
  if (!title) {
    throw new Error("Scheduled task title is required.");
  }
  if (!input.scheduledAt) {
    throw new Error("Scheduled time is required.");
  }

  const now = new Date().toISOString();
  const task: ScheduledTask = {
    id: createOpaqueId(),
    title,
    description: input.description?.trim() ?? "",
    assignee: input.assignee,
    channelName: input.channelName,
    repeat: input.repeat,
    cronExpression: input.cronExpression,
    scheduledAt: input.scheduledAt,
    nextRunAt: input.scheduledAt,
    status: "active",
    createdBy: input.createdBy ?? "",
    createdAt: now,
    updatedAt: now,
  };

  if (!state.scheduledTasks) {
    state.scheduledTasks = [];
  }
  state.scheduledTasks.push(task);
  state.ledger.unshift({
    title: "Scheduled task created",
    note: `Created scheduled task "${title}" (${input.repeat}).`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateScheduledTaskSync(
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
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = (state.scheduledTasks ?? []).find((t) => t.id === id);
  if (!task) {
    throw new Error(`Scheduled task "${id}" does not exist.`);
  }

  if (typeof input.title === "string") {
    const trimmed = input.title.trim();
    if (!trimmed) {
      throw new Error("Scheduled task title is required.");
    }
    task.title = trimmed;
  }

  if (typeof input.description === "string") {
    task.description = input.description.trim();
  }

  if (input.assignee !== undefined) {
    task.assignee = input.assignee || undefined;
  }

  if (input.channelName !== undefined) {
    task.channelName = input.channelName || undefined;
  }

  if (input.repeat) {
    task.repeat = input.repeat;
  }

  if (input.cronExpression !== undefined) {
    task.cronExpression = input.cronExpression || undefined;
  }

  if (input.scheduledAt) {
    task.scheduledAt = input.scheduledAt;
    task.nextRunAt = input.scheduledAt;
  }

  task.updatedAt = new Date().toISOString();

  state.ledger.unshift({
    title: "Scheduled task updated",
    note: `Updated scheduled task "${task.title}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function toggleScheduledTaskSync(id: string, status: "active" | "paused", workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = (state.scheduledTasks ?? []).find((t) => t.id === id);
  if (!task) {
    throw new Error(`Scheduled task "${id}" does not exist.`);
  }

  task.status = status;
  task.updatedAt = new Date().toISOString();

  return writeWorkspaceStateSync(state, workspaceId);
}

export function deleteScheduledTaskSync(id: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = (state.scheduledTasks ?? []).find((t) => t.id === id);
  if (!task) {
    throw new Error(`Scheduled task "${id}" does not exist.`);
  }

  state.scheduledTasks = (state.scheduledTasks ?? []).filter((t) => t.id !== id);

  state.ledger.unshift({
    title: "Scheduled task deleted",
    note: `Deleted scheduled task "${task.title}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}
