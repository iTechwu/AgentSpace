import { listQueuedTasksSync } from "@dofe-agent/db";
import type { QueuedTaskRecord } from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";

export interface AgentPerformanceMetrics {
  agentId: string;
  displayName: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  completionRate: number;
  errorRate: number;
  avgResponseTimeMs: number | null;
  approvalCount: number;
  rejectionCount: number;
  satisfactionRate: number | null;
}

export interface PerformanceDashboardData {
  agents: AgentPerformanceMetrics[];
  totalTasks: number;
  totalCompleted: number;
  totalFailed: number;
  overallCompletionRate: number;
  overallErrorRate: number;
  overallAvgResponseTimeMs: number | null;
}

export function getPerformanceDashboardDataSync(workspaceId?: string): PerformanceDashboardData {
  const state = ensureWorkspaceStateSync(workspaceId);
  const queuedTasks = listQueuedTasksSync({ workspaceId });

  const tasksByAgent = new Map<string, QueuedTaskRecord[]>();
  for (const task of queuedTasks) {
    const list = tasksByAgent.get(task.employeeId) ?? [];
    list.push(task);
    tasksByAgent.set(task.employeeId, list);
  }

  const employeeIdByName = new Map(state.activeEmployees.map((employee) => [employee.name, employee.id]));
  const approvalsByAgent = new Map<string, { approved: number; rejected: number }>();
  for (const approval of state.approvals ?? []) {
    const approvalEmployeeId = employeeIdByName.get(approval.agentId) ?? approval.agentId;
    const entry = approvalsByAgent.get(approvalEmployeeId) ?? { approved: 0, rejected: 0 };
    if (approval.status === "approved") {
      entry.approved += 1;
    } else if (approval.status === "rejected") {
      entry.rejected += 1;
    }
    approvalsByAgent.set(approvalEmployeeId, entry);
  }

  const employeeEntries: Array<[string, ActiveEmployee]> = state.activeEmployees.map((employee: ActiveEmployee) => [
    employee.id,
    employee,
  ]);
  const employeeIndex = new Map<string, ActiveEmployee>(employeeEntries);

  const agentIds = new Set<string>();
  for (const task of queuedTasks) {
    agentIds.add(task.employeeId);
  }
  for (const employee of state.activeEmployees) {
    agentIds.add(employee.id);
  }

  const agents: AgentPerformanceMetrics[] = Array.from(agentIds)
    .map((agentId) => {
      const tasks = tasksByAgent.get(agentId) ?? [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      const total = tasks.length;
      const responseTimes = computeResponseTimes(tasks);
      const approvals = approvalsByAgent.get(agentId) ?? { approved: 0, rejected: 0 };
      const totalReviewed = approvals.approved + approvals.rejected;
      const employee: ActiveEmployee | undefined = employeeIndex.get(agentId);

      return {
        agentId,
        displayName: employee?.remarkName?.trim() || employee?.name || agentId,
        totalTasks: total,
        completedTasks: completed,
        failedTasks: failed,
        completionRate: total > 0 ? completed / total : 0,
        errorRate: total > 0 ? failed / total : 0,
        avgResponseTimeMs: responseTimes.length > 0
          ? responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length
          : null,
        approvalCount: approvals.approved,
        rejectionCount: approvals.rejected,
        satisfactionRate: totalReviewed > 0
          ? approvals.approved / totalReviewed
          : null,
      };
    })
    .sort((a, b) => b.totalTasks - a.totalTasks);

  const totalTasks = queuedTasks.length;
  const totalCompleted = queuedTasks.filter((t) => t.status === "completed").length;
  const totalFailed = queuedTasks.filter((t) => t.status === "failed").length;
  const allResponseTimes = computeResponseTimes(queuedTasks);

  return {
    agents,
    totalTasks,
    totalCompleted,
    totalFailed,
    overallCompletionRate: totalTasks > 0 ? totalCompleted / totalTasks : 0,
    overallErrorRate: totalTasks > 0 ? totalFailed / totalTasks : 0,
    overallAvgResponseTimeMs: allResponseTimes.length > 0
      ? allResponseTimes.reduce((sum, t) => sum + t, 0) / allResponseTimes.length
      : null,
  };
}

function computeResponseTimes(tasks: QueuedTaskRecord[]): number[] {
  const times: number[] = [];
  for (const task of tasks) {
    if (task.status !== "completed" && task.status !== "failed") {
      continue;
    }
    if (!task.finishedAt || !task.queuedAt) {
      continue;
    }
    const queuedMs = new Date(task.queuedAt).getTime();
    const finishedMs = new Date(task.finishedAt).getTime();
    if (!Number.isFinite(queuedMs) || !Number.isFinite(finishedMs)) {
      continue;
    }
    const diff = finishedMs - queuedMs;
    if (diff >= 0) {
      times.push(diff);
    }
  }
  return times;
}
