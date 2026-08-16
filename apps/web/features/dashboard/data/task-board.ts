// dashboard 任务看板页（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import type { DashboardCurrentUser } from "../data-types";
import { listRunnableWorkflowsSync } from "@/features/workflows/workflow-data";
import type { RunnableWorkflowSummary } from "@/features/workflows/workflow-data";
import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type { DofeAgentState, TaskRecord, TaskStatus } from "@dofe-agent/domain/workspace";
import { canSeeWorkspaceDiagnostics, limitLoadtestDashboardPayload } from "./agents.ts";
import { TASK_BOARD_TASK_LIMIT, readWorkspaceStateCached } from "./cached.ts";
import { buildReadableChannelLookup } from "./inbox.ts";

export type TaskBoardGroupBy = "status" | "assignee" | "priority" | "channel";
export interface TaskBoardColumn {
  key: string;
  label: string;
  tasks: TaskRecord[];
}
export interface TaskBoardPageData {
  tasks: TaskRecord[];
  columns: TaskBoardColumn[];
  agents: Array<{ id: string; name: string }>;
  channels: Array<{ name: string }>;
  runnableWorkflows: RunnableWorkflowSummary[];
  totalCount: number;
  todoCount: number;
  inProgressCount: number;
  doneCount: number;
}
export function getTaskBoardPageData(
  groupBy: TaskBoardGroupBy = "status",
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUser?: DashboardCurrentUser,
): TaskBoardPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const canSeeAllAgents = canSeeWorkspaceDiagnostics(currentUser);
  const readableChannels = buildReadableChannelLookup(state, workspaceId, currentUser);
  const visibleChannels = currentUser?.id
    ? state.channels.filter((channel) => readableChannels.canRead(channel.name))
    : state.channels;
  const visibleChannelNames = new Set(visibleChannels.map((channel) => channel.name));
  const visibleChannelAgentNames = new Set(visibleChannels.flatMap((channel) => channel.employeeNames));
  const visibleAgents = canSeeAllAgents
    ? state.activeEmployees
    : state.activeEmployees.filter((employee) =>
        employee.ownerUserId === currentUser?.id ||
        (
          (employee.channelMemberAccess ?? "enabled") === "enabled" &&
          visibleChannelAgentNames.has(employee.name)
        ),
      );
  const visibleAgentNames = new Set(visibleAgents.map((employee) => employee.name));
  const tasks = state.tasks
    .filter((task) => canSeeAllAgents || visibleAgentNames.has(task.assignee))
    .filter((task) => !currentUser?.id || visibleChannelNames.has(task.channel))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const taskPreview = limitLoadtestDashboardPayload(tasks, TASK_BOARD_TASK_LIMIT);

  const columns = buildTaskBoardColumns(taskPreview, groupBy, state);

  return {
    tasks: taskPreview,
    columns,
    agents: visibleAgents.map((employee) => ({
      id: employee.name,
      name: employee.remarkName?.trim() || employee.name,
    })),
    channels: visibleChannels.map((channel) => ({ name: channel.name })),
    runnableWorkflows: listRunnableWorkflowsSync(workspaceId),
    totalCount: tasks.length,
    todoCount: tasks.filter((t) => t.status === "todo").length,
    inProgressCount: tasks.filter((t) => t.status === "in_progress").length,
    doneCount: tasks.filter((t) => t.status === "done").length,
  };
}
export function buildTaskBoardColumns(
  tasks: TaskRecord[],
  groupBy: TaskBoardGroupBy,
  state: DofeAgentState,
): TaskBoardColumn[] {
  if (groupBy === "status") {
    const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
    const labels: Record<TaskStatus, string> = {
      todo: "Todo",
      in_progress: "In Progress",
      blocked: "Blocked",
      done: "Done",
    };
    return statuses.map((status) => ({
      key: status,
      label: labels[status],
      tasks: tasks.filter((t) => t.status === status),
    }));
  }

  if (groupBy === "assignee") {
    const assignees = [...new Set(tasks.map((t) => t.assignee))];
    const employeeIndex = new Map(
      state.activeEmployees.map((e) => [e.name, e]),
    );
    return assignees.map((assignee) => ({
      key: assignee,
      label: employeeIndex.get(assignee)?.remarkName?.trim() || assignee,
      tasks: tasks.filter((t) => t.assignee === assignee),
    }));
  }

  if (groupBy === "priority") {
    const priorities: Array<TaskRecord["priority"]> = ["high", "medium", "low"];
    return priorities.map((priority) => ({
      key: priority,
      label: priority.charAt(0).toUpperCase() + priority.slice(1),
      tasks: tasks.filter((t) => t.priority === priority),
    }));
  }

  // groupBy === "channel"
  const channelNames = [...new Set(tasks.map((t) => t.channel))];
  return channelNames.map((channelName) => ({
    key: channelName,
    label: `#${channelName}`,
    tasks: tasks.filter((t) => t.channel === channelName),
  }));
}
