import {
  createStoredTaskSync,
  enqueueNativeTaskSync,
  listQueuedTasksSync,
  readEmployeeRuntimeBindingSync,
  updateStoredTaskSync,
  buildTaskExecutionEventContext,
} from "@dofe-agent/db";
import { type DofeAgentState, type TaskRecord, type TaskStatus } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, createOpaqueId } from "../shared/helpers.ts";
import { pushWorkspaceMessageToChannel } from "../shared/messaging.ts";
import {
  assertCanUseBoundEmployeeRuntimeInChannelForActorSync,
  assertCanUseEmployeeInChannelForActorSync,
} from "../runtime-access/runtime-access.ts";
import { recordTaskExecutionEventSync } from "../task-execution-events.ts";

const RUNTIME_COORDINATOR = "系统提示";
const TASK_DISPATCHER = "系统提示";

export function listTasksSync(workspaceId?: string): TaskRecord[] {
  return ensureWorkspaceStateSync(workspaceId).tasks;
}

export function createTaskSync(input: {
  title: string;
  channel: string;
  assignee: string;
  priority: TaskRecord["priority"];
  requestedByUserId?: string;
  requestedByDisplayName?: string;
}, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);

  if (!state.channels.some((channel) => sameValue(channel.name, input.channel))) {
    throw new Error(`Channel "${input.channel}" does not exist.`);
  }

  if (!state.activeEmployees.some((employee) => sameValue(employee.name, input.assignee))) {
    throw new Error(`Active employee "${input.assignee}" does not exist.`);
  }
  if (input.requestedByUserId) {
    assertCanUseEmployeeInChannelForActorSync({
      workspaceId,
      employeeName: input.assignee,
      channelName: input.channel,
      actorUserId: input.requestedByUserId,
      actorDisplayName: input.requestedByDisplayName,
    });
    assertCanUseBoundEmployeeRuntimeInChannelForActorSync({
      workspaceId,
      employeeName: input.assignee,
      channelName: input.channel,
      actorUserId: input.requestedByUserId,
      actorDisplayName: input.requestedByDisplayName,
    });
  }

  state.tasks.unshift({
    id: `task-${Date.now()}`,
    title: input.title,
    channel: input.channel,
    assignee: input.assignee,
    priority: input.priority,
    status: "todo",
  });
  const createdTask = state.tasks[0];
  if (createdTask) {
    createStoredTaskSync(createdTask, workspaceId);
  }
  state.pendingHandoffs += 1;
  state.ledger.unshift({
    title: "Task created",
    note: `${input.assignee} received task ${input.title} in ${input.channel}.`,
  });
  pushWorkspaceMessageToChannel(state, input.channel, {
    speaker: TASK_DISPATCHER,
    role: "agent",
    summary: `A new task was assigned to ${input.assignee}: ${input.title}.`,
    code: "task.assigned_notice",
    data: { assignee: input.assignee, task_title: input.title },
  }, workspaceId);

  const binding = readEmployeeRuntimeBindingSync(input.assignee, workspaceId);
  if (binding && createdTask) {
    const queued = enqueueNativeTaskSync({
      workspaceId,
      taskId: createdTask.id,
      assignee: input.assignee,
      title: input.title,
      channel: input.channel,
      priority: input.priority,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
    });

    if (queued) {
      state.ledger.unshift({
        title: "Task queued",
        note: `${input.title} entered the native queue and is waiting for ${binding.runtimeName}.`,
      });
      pushWorkspaceMessageToChannel(state, input.channel, {
        speaker: RUNTIME_COORDINATOR,
        role: "agent",
        summary: `Task ${input.title} entered the native queue for runtime ${binding.runtimeName}.`,
        code: "task.queued_notice",
        data: { task_title: input.title, runtime_name: binding.runtimeName },
      }, workspaceId);
    }
  }

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateTaskStatusSync(taskId: string, status: TaskStatus, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error(`Task "${taskId}" does not exist.`);
  }

  task.status = status;
  updateStoredTaskSync(task.id, task, workspaceId);
  state.ledger.unshift({
    title: "Task status updated",
    note: `Task ${task.title} was updated to ${status}.`,
  });
  pushWorkspaceMessageToChannel(state, task.channel, {
    speaker: TASK_DISPATCHER,
    role: "agent",
    summary: `Task ${task.title} status was updated to ${status}.`,
    code: "task.status_notice",
    data: { task_title: task.title, status },
  }, workspaceId);
  if (status === "blocked") {
    recordTaskBlockedByWorkspaceStatus(task, workspaceId);
  }

  if (status === "done" && state.pendingHandoffs > 0) {
    state.pendingHandoffs -= 1;
  }

  return writeWorkspaceStateSync(state, workspaceId);
}

function recordTaskBlockedByWorkspaceStatus(task: TaskRecord, workspaceId?: string): void {
  const queued = listQueuedTasksSync({ workspaceId }).find((candidate) => candidate.issueId === task.id);
  if (!queued) {
    return;
  }
  const context = buildTaskExecutionEventContext(queued);
  recordTaskExecutionEventSync({
    ...context,
    type: "blocked",
    title: "Task marked blocked",
    summary: `${task.title} needs intervention before it can continue.`,
    severity: "warning",
    status: "failed",
    data: {
      issueId: task.id,
      taskTitle: task.title,
      workspaceTaskStatus: task.status,
      triggerType: context.triggerType,
    },
  });
}

export function reorderTaskSync(taskId: string, newSortOrder: number, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error(`Task "${taskId}" does not exist.`);
  }

  task.sortOrder = newSortOrder;
  updateStoredTaskSync(task.id, task, workspaceId);
  return writeWorkspaceStateSync(state, workspaceId);
}

export function addTaskLabelSync(taskId: string, label: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error(`Task "${taskId}" does not exist.`);
  }

  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("Label cannot be empty.");
  }

  const existing = task.labels ?? [];
  if (!existing.includes(trimmed)) {
    task.labels = [...existing, trimmed];
  }
  updateStoredTaskSync(task.id, task, workspaceId);

  return writeWorkspaceStateSync(state, workspaceId);
}

export function removeTaskLabelSync(taskId: string, label: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error(`Task "${taskId}" does not exist.`);
  }

  task.labels = (task.labels ?? []).filter((existing) => existing !== label.trim());
  updateStoredTaskSync(task.id, task, workspaceId);
  return writeWorkspaceStateSync(state, workspaceId);
}
