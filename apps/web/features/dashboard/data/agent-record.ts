// dashboard WorkspaceAgentRecord 构建与格式化（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { safeReadTaskTitle, sameText } from "../dashboard-view-builders";
import type { AgentWorkAreaRecord, ContainerRecord, InboxItem, ManagementRecordBase, RuntimeMcpConnectionView, WorkspaceAgentDocumentAccessSummaryRecord, WorkspaceAgentKnowledgeRecord, WorkspaceAgentRecord, WorkspaceAgentStatus } from "../data-types";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { listQueuedTasksSync, listRuntimeAppOperationsSync, listRuntimeInstalledAppsSync, listTaskMessagesForTaskSync } from "@dofe-agent/db";
import { formatDaemonProviderLabel, isDaemonProvider } from "@dofe-agent/domain";
import type { ActiveEmployee, ApprovalRequest, DofeAgentState, TaskRecord, TaskStatus, WorkspaceMessage, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { buildLegacyAgentIdForEmployeeName } from "@dofe-agent/services/employees";
import { normalizeCliHubReadiness, readAgentSkillRequirementSummarySync } from "@dofe-agent/services/skills";
import { normalizeRuntimeProviderHealth } from "@dofe-agent/services/runtime";
import type { AgentSkillRequirementSummary } from "@dofe-agent/services/skills";
import type { WorkspaceNotificationRecord } from "@dofe-agent/services/workspace";
import { buildRouterExecutionView, buildTaskExecutionTimeline, limitLoadtestDashboardPayload } from "./agents.ts";
import { AGENT_TASK_PREVIEW_LIMIT } from "./cached.ts";
import { resolveAssignedSkillIdsForEmployee } from "./inbox-items.ts";

export function buildWorkspaceAgentRecord(
  employee: ActiveEmployee,
  state: DofeAgentState,
  workspaceId: string,
  workspaceSkillIndex: Map<string, WorkspaceSkill>,
  skillIdsByAgentId: Map<string, string[]>,
  binding:
    | {
        runtimeId: string;
        runtimeName: string;
        provider: string;
        boundAt: string;
      }
    | undefined,
  runtimeIndex: Map<string, ContainerRecord>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  knowledge: WorkspaceAgentKnowledgeRecord,
  documentAccess: WorkspaceAgentDocumentAccessSummaryRecord,
): WorkspaceAgentRecord {
  const assignedSkillIds = resolveAssignedSkillIdsForEmployee(skillIdsByAgentId, employee);
  const assignedSkills = assignedSkillIds
    .map((skillId) => workspaceSkillIndex.get(skillId))
    .filter((skill): skill is WorkspaceSkill => Boolean(skill));
  const runtimeProvider = binding?.provider && isDaemonProvider(binding.provider)
    ? binding.provider
    : undefined;
  const runtime = binding?.runtimeId ? runtimeIndex.get(binding.runtimeId) : undefined;
  const runtimeOnline = runtime ? runtime.status === "linked" : undefined;
  const runtimeCapabilities = runtime
    ? [
        "dofe-agent-output",
        ...runtime.installedApps
          .filter((app) => app.status === "installed" && app.enabled && app.entryPoint?.trim())
          .map((app) => `clihub:${app.source}:${app.name}`),
      ]
    : undefined;
  const skillRequirements = Object.fromEntries(assignedSkills.map((skill) => [
    skill.id,
    readAgentSkillRequirementSummarySync({
      workspaceId,
      employeeName: employee.name,
      skillId: skill.id,
      runtimeProvider,
      runtimeCapabilities,
      runtimeOnline,
    }),
  ]));
  const tasks = state.tasks.filter((task) => task.assignee === employee.name);
  const taskPreview = limitLoadtestDashboardPayload(tasks, AGENT_TASK_PREVIEW_LIMIT);
  const recentMessages = state.messages.filter((message) => isMessageRelevantToAgent(message, employee.name, tasks)).slice(0, 6);
  const workspaceTaskIndex = new Map(state.tasks.map((task) => [task.id, task]));
  const workAreaMap = new Map<string, AgentWorkAreaRecord>();
  const workAreaUpdatedAt = new Map<string, number>();
  const relevantQueuedTasks = queuedTasks
    .filter((queuedTask) => queuedTask.agentId === employee.name)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const queuedTaskIndex = new Map(relevantQueuedTasks.map((queuedTask) => [queuedTask.id, queuedTask]));

  for (const workspace of (state.conversationExecutionWorkspaces ?? []).filter((workspace) => workspace.agentId === employee.name)) {
    const queuedTask = workspace.lastTaskQueueId ? queuedTaskIndex.get(workspace.lastTaskQueueId) : undefined;
    const task = queuedTask?.issueId ? workspaceTaskIndex.get(queuedTask.issueId) : undefined;

    workAreaMap.set(workspace.conversationKey, {
      id: workspace.conversationKey,
      queueId: workspace.lastTaskQueueId ?? workspace.conversationKey,
      title: workspace.contactId ?? task?.title ?? workspace.channelName,
      channel: workspace.channelName,
      queueStatus: queuedTask ? formatNativeQueueStatus(queuedTask.status) : "not_queued",
      taskStatus: task ? formatTaskStatus(task.status) : undefined,
      updatedAt: formatAbsoluteDateTime(workspace.updatedAt),
      updatedAtEpochMs: latestTimestampMs(workspace.updatedAt, queuedTask?.updatedAt),
      startedAt: queuedTask?.startedAt,
      finishedAt: queuedTask?.finishedAt,
      sessionId: workspace.sessionId,
      router: buildRouterExecutionView(queuedTask),
      workDir: workspace.workDir,
      workDirAccess: runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined,
      workDirHostLabel: runtime?.deviceName,
      errorText: workspace.lastError ?? queuedTask?.errorText,
    });
    workAreaUpdatedAt.set(
      workspace.conversationKey,
      latestTimestampMs(workspace.updatedAt, queuedTask?.updatedAt),
    );
  }

  for (const queuedTask of relevantQueuedTasks) {
    const task = queuedTask.issueId ? workspaceTaskIndex.get(queuedTask.issueId) : undefined;
    const payload = safeParseQueuePayloadWithMetadata(queuedTask.inputJson);
    const workAreaKey =
      payload.channelName
        ? `channel:${payload.channelName}`
        : payload.contactId
          ? `contact:${payload.contactId}`
          : task?.channel
            ? `channel:${task.channel}`
            : queuedTask.workDir ?? queuedTask.id;

    const queuedUpdatedAt = Date.parse(queuedTask.updatedAt);
    const existingUpdatedAt = workAreaUpdatedAt.get(workAreaKey) ?? Number.NEGATIVE_INFINITY;
    const existingWorkArea = workAreaMap.get(workAreaKey);
    const sameTimestampTerminalWins = existingWorkArea
      && queuedUpdatedAt === existingUpdatedAt
      && isTerminalQueueStatus(queuedTask.status)
      && isActiveQueueStatus(existingWorkArea.queueStatus);
    if (
      existingWorkArea
      && !isLaterTimestamp(queuedUpdatedAt, existingUpdatedAt)
      && !sameTimestampTerminalWins
    ) {
      continue;
    }

    workAreaMap.set(workAreaKey, {
      id: queuedTask.id,
      queueId: queuedTask.id,
      title: task?.title ?? safeReadTaskTitle(queuedTask.inputJson) ?? queuedTask.id,
      channel: payload.channelName ?? task?.channel,
      queueStatus: formatNativeQueueStatus(queuedTask.status),
      taskStatus: task ? formatTaskStatus(task.status) : undefined,
      updatedAt: formatAbsoluteDateTime(queuedTask.updatedAt),
      updatedAtEpochMs: queuedUpdatedAt,
      startedAt: queuedTask.startedAt,
      finishedAt: queuedTask.finishedAt,
      sessionId: queuedTask.sessionId,
      router: buildRouterExecutionView(queuedTask),
      workDir: queuedTask.workDir,
      workDirAccess: runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined,
      workDirHostLabel: runtime?.deviceName,
      errorText: queuedTask.errorText,
    });
    workAreaUpdatedAt.set(workAreaKey, queuedUpdatedAt);
  }

  const workAreas = Array.from(workAreaMap.values());

  const status = statusForWorkspaceAgent(tasks, workAreas, state.approvals, employee.name, runtime?.status);

  return {
    id: buildLegacyAgentIdForEmployeeName(employee.name),
    employeeId: employee.id,
    kind: "agent",
    name: employee.remarkName?.trim() || employee.name,
    subtitle: employee.name,
    description: employee.summary,
    status,
    statusLabel: labelForAgentStatus(status),
    tags: [
      employee.origin,
      assignedSkills.length > 0 ? `${assignedSkills.length} skills` : "no_skills",
      employee.channels.length > 0 ? `${employee.channels.length} channels` : "unassigned_channels",
      tasks.length > 0 ? `${tasks.length} tasks` : "no_tasks",
    ],
    internalName: employee.name,
    ownerUserId: employee.ownerUserId,
    canManage: true,
    canManageChannelMemberAccess: true,
    channelMemberAccess: employee.channelMemberAccess ?? (employee.ownerUserId ? "disabled" : "enabled"),
    origin: employee.origin,
    fit: employee.fit,
    summary: employee.summary,
    skills: assignedSkills,
    skillRequirements,
    channels: employee.channels,
    tasks: taskPreview,
    recentMessages,
    boundContainerId: binding?.runtimeId,
    boundContainerName: runtime?.name ?? binding?.runtimeName,
    boundContainerStatus: runtime ? (runtime.status === "linked" ? "online" : "offline") : undefined,
    boundProvider: binding?.provider,
    boundProviderHealth: runtime?.providerHealth,
    boundAt: binding?.boundAt,
    runtimeCapabilities: runtime ? {
      cliApps: runtime.installedApps.filter((app) => app.status === "installed" && app.enabled),
      mcpServices: (runtime.mcpConnections ?? []).filter((connection) => connection.status === "ready"),
    } : undefined,
    defaultModel: employee.defaultModel,
    executionPolicy: employee.executionPolicy,
    workAreas,
    instructions: employee.instructions,
    knowledge,
    documentAccess,
  };
}

/**
 * Returns a viewer-safe skill-requirements map for non-managers (spec §3.3).
 * Keeps only the aggregate readiness signal (status + counts + dependency
 * status) so a viewer can tell "可用 / 需管理员处理". Drops everything that
 * carries a variable name, value, blocker detail, or actor identity.
 */
export function redactSkillRequirementsForViewer(
  skillRequirements: Record<string, AgentSkillRequirementSummary>,
): Record<string, AgentSkillRequirementSummary> {
  return Object.fromEntries(Object.entries(skillRequirements).map(([skillId, summary]) => [
    skillId,
    {
      skillId: summary.skillId,
      status: summary.status,
      statusDetail: summary.statusDetail,
      requiredCount: summary.requiredCount,
      configuredCount: summary.configuredCount,
      blockers: [],
      environment: [],
      runtimeOnline: summary.runtimeOnline,
      dependencyInstallStatus: summary.dependencyInstallStatus,
    } satisfies AgentSkillRequirementSummary,
  ]));
}
export function buildNativeRuntimeRecord(
  daemon: {
    daemonKey: string;
    deviceName: string;
    status: "online" | "offline";
    metadataJson: string;
    lastHeartbeatAt?: string;
  },
  runtime: {
    id: string;
    provider: string;
    name: string;
    version: string;
    status: "online" | "offline";
    deviceInfo: string;
    metadataJson: string;
    lastHeartbeatAt?: string;
    lastError?: string;
  },
  displayName: string | undefined,
  boundEmployees: string[],
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  installedApps: ReturnType<typeof listRuntimeInstalledAppsSync>,
  runtimeAppOperations: ReturnType<typeof listRuntimeAppOperationsSync>,
  mcpConnections: RuntimeMcpConnectionView[],
  workspaceTaskById: Map<string, TaskRecord>,
): ContainerRecord {
  const runtimeMetadata = safeParseJson(runtime.metadataJson);
  const daemonMetadata = safeParseJson(daemon.metadataJson);
  const daemonMode = resolveDaemonMode(runtimeMetadata, daemonMetadata);
  const executionWorkDirAccess: "local" | "remote" = daemonMode === "remote" ? "remote" : "local";
  const serverUrl = typeof daemonMetadata.serverUrl === "string" ? daemonMetadata.serverUrl : undefined;
  const status: WorkspaceAgentStatus = runtime.status === "online" ? "linked" : "error";
  const providerHealth = normalizeRuntimeProviderHealth({
    runtimeStatus: runtime.status,
    runtimeMetadata,
    lastError: runtime.lastError,
  });
  const providerLabel = formatDaemonProviderLabel(runtime.provider);
  const trimmedDisplayName = displayName?.trim();
  const queueCounts = {
    queued: queuedTasks.filter((task) => task.status === "queued" || task.status === "claimed").length,
    running: queuedTasks.filter((task) => task.status === "running").length,
    failed: queuedTasks.filter((task) => task.status === "failed").length,
    completed: queuedTasks.filter((task) => task.status === "completed").length,
  };
  const recentExecutions = queuedTasks
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 8)
    .map((queuedTask) => {
      const task = queuedTask.issueId ? workspaceTaskById.get(queuedTask.issueId) : undefined;
      const payload = safeParseQueuePayloadWithMetadata(queuedTask.inputJson);
      const taskMessages = listTaskMessagesForTaskSync(queuedTask.id).map((message) => ({
        id: message.id,
        type: message.type,
        content: message.content ?? message.output ?? message.type,
        createdAt: message.createdAt,
        status: (message.type === "error" ? "error" : "completed") as "error" | "completed",
      }));
      const timeline = buildTaskExecutionTimeline(queuedTask.id, queuedTask.workspaceId, 8);
      const router = buildRouterExecutionView(queuedTask);
      return {
        queueId: queuedTask.id,
        taskId: queuedTask.issueId,
        title: task?.title ?? safeReadTaskTitle(queuedTask.inputJson) ?? queuedTask.id,
        assignee: task?.assignee ?? queuedTask.agentId,
        channel: task?.channel ?? payload.channelName,
        queueStatus: formatNativeQueueStatus(queuedTask.status),
        taskStatus: task ? formatTaskStatus(task.status) : undefined,
        messageCount: taskMessages.length,
        startedAt: queuedTask.startedAt,
        finishedAt: queuedTask.finishedAt,
        sessionId: queuedTask.sessionId,
        router,
        workDir: queuedTask.workDir,
        workDirAccess: executionWorkDirAccess,
        workDirHostLabel: runtime.deviceInfo || daemon.deviceName,
        errorText: queuedTask.errorText,
        taskMessages,
        timeline,
      };
    });
  const cliHubReadiness = normalizeCliHubReadiness(daemonMetadata.cliHubReadiness);
  const installedAppViews = installedApps.map((app) => ({
    source: app.source,
    name: app.name,
    displayName: app.displayName,
    version: app.version,
    entryPoint: app.entryPoint,
    status: app.status,
    enabled: app.enabled,
    lastError: app.lastError,
    updatedAt: app.updatedAt,
  }));
  const recentAppOperations = runtimeAppOperations
    .slice()
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 8)
    .map((operation) => ({
      id: operation.id,
      appSource: operation.appSource,
      appName: operation.appName,
      operation: operation.operation,
      status: operation.status,
      createdAt: operation.createdAt,
      errorMessage: operation.errorMessage,
    }));

  return {
    id: `runtime:${runtime.id}`,
    kind: "container",
    name: runtime.name,
    subtitle: `${providerLabel} · ${runtime.deviceInfo || daemon.deviceName}`,
    description:
      runtime.status === "online" && providerHealth.providerUsable === "unusable"
        ? `Provider unavailable: ${providerHealth.providerHealthReason ?? providerHealth.lastProviderErrorMessage ?? "health check failed"}`
        : runtime.status === "online"
        ? "The container is online and can host independent work areas for multiple agents."
        : runtime.lastError || "The container is currently offline.",
    status,
    statusLabel: labelForAgentStatus(status),
    tags: [
      daemon.deviceName,
      runtime.version || "version_unavailable",
      runtime.lastHeartbeatAt ?? daemon.lastHeartbeatAt ?? "heartbeat_unavailable",
    ],
    runtimeId: runtime.id,
    provider: runtime.provider,
    displayName: trimmedDisplayName || undefined,
    daemonKey: daemon.daemonKey,
    deviceName: runtime.deviceInfo || daemon.deviceName,
    runtimeStatus: runtime.status,
    providerHealth,
    daemonMode,
    serverUrl,
    version: runtime.version || undefined,
    lastHeartbeatAt: runtime.lastHeartbeatAt ?? daemon.lastHeartbeatAt,
    executablePath:
      typeof runtimeMetadata.executablePath === "string" ? runtimeMetadata.executablePath : undefined,
    daemonPid: typeof daemonMetadata.pid === "string" ? daemonMetadata.pid : undefined,
    cliHubReadiness,
    installedApps: installedAppViews,
    mcpConnections,
    recentAppOperations,
    grantedMembers: [],
    canManageGrants: false,
    boundEmployees,
    agentCount: boundEmployees.length,
    queueCounts,
    recentExecutions,
  };
}
export function compareContainers(left: ContainerRecord, right: ContainerRecord): number {
  const leftPriority = priorityForAgentStatus(left.status);
  const rightPriority = priorityForAgentStatus(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}
export function compareAgents(left: ManagementRecordBase, right: ManagementRecordBase): number {
  const leftPriority = priorityForAgentStatus(left.status);
  const rightPriority = priorityForAgentStatus(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}
export function safeParseJson(value: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
export function resolveDaemonMode(
  runtimeMetadata: Record<string, unknown>,
  daemonMetadata: Record<string, unknown>,
): "local" | "remote" {
  const runtimeMode = runtimeMetadata.mode;
  if (runtimeMode === "local" || runtimeMode === "remote") {
    return runtimeMode;
  }
  const daemonMode = daemonMetadata.mode;
  if (daemonMode === "local" || daemonMode === "remote") {
    return daemonMode;
  }
  return "local";
}
export function toneForTask(status: TaskStatus): InboxItem["statusTone"] {
  if (status === "done") {
    return "positive";
  }
  if (status === "blocked") {
    return "danger";
  }
  if (status === "in_progress") {
    return "warning";
  }
  return "neutral";
}
export function toneForNotification(notification: WorkspaceNotificationRecord): InboxItem["statusTone"] {
  if (notification.severity === "critical") {
    return "danger";
  }
  if (notification.severity === "warning") {
    return "warning";
  }
  if (notification.severity === "success") {
    return "positive";
  }
  return "neutral";
}
export function formatNotificationStatus(status: WorkspaceNotificationRecord["status"]): string {
  if (status === "unread") {
    return "Unread";
  }
  if (status === "archived") {
    return "Archived";
  }
  return "Read";
}
export function formatNotificationResourceType(resourceType: WorkspaceNotificationRecord["resourceType"]): string {
  if (resourceType === "workspace_member") {
    return "Workspace member";
  }
  return resourceType.charAt(0).toUpperCase() + resourceType.slice(1);
}
export function statusForWorkspaceAgent(
  tasks: TaskRecord[],
  workAreas: AgentWorkAreaRecord[],
  approvals: ApprovalRequest[],
  employeeName: string,
  containerStatus?: WorkspaceAgentStatus,
): WorkspaceAgentStatus {
  if (containerStatus === "error") {
    return "error";
  }
  if (workAreas.some((area) => isActiveQueueStatus(area.queueStatus))) {
    return "busy";
  }
  if (tasks.some((task) => task.status === "in_progress")) {
    return "busy";
  }
  if (approvals.some((approval) => approval.agentId === employeeName && approval.status === "pending")) {
    return "awaiting_confirmation";
  }

  // A task board keeps historical failures for audit. Only the newest execution
  // workspace represents the employee's current operational state; otherwise a
  // later successful conversation could never clear an earlier failure.
  const latestWorkArea = workAreas.reduce<AgentWorkAreaRecord | undefined>((latest, area) => (
    !latest || (area.updatedAtEpochMs ?? Number.NEGATIVE_INFINITY) > (latest.updatedAtEpochMs ?? Number.NEGATIVE_INFINITY)
      ? area
      : latest
  ), undefined);
  if (latestWorkArea?.taskStatus === "blocked" || latestWorkArea?.queueStatus === "failed") {
    return "blocked";
  }
  if (workAreas.length === 0 && tasks.some((task) => task.status === "blocked")) {
    return "blocked";
  }
  return "online";
}
export function latestTimestampMs(...values: Array<string | undefined>): number {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}
export function isLaterTimestamp(candidate: number, current: number): boolean {
  if (!Number.isFinite(candidate)) return false;
  if (!Number.isFinite(current)) return true;
  return candidate > current;
}
export function isActiveQueueStatus(status: string): boolean {
  return status === "queued"
    || status === "claimed"
    || status === "running"
    || status === "preparing_commit";
}
export function isTerminalQueueStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "committed";
}
export function formatTaskStatus(status: TaskStatus): string {
  return status;
}
export function formatPriority(priority: TaskRecord["priority"]): string {
  return priority;
}
export function labelForAgentStatus(status: WorkspaceAgentStatus): string {
  return status;
}
export function priorityForAgentStatus(status: WorkspaceAgentStatus): number {
  if (status === "error") {
    return 0;
  }
  if (status === "blocked") {
    return 1;
  }
  if (status === "awaiting_confirmation") {
    return 2;
  }
  if (status === "busy") {
    return 3;
  }
  if (status === "linked") {
    return 4;
  }
  return 5;
}
export function formatAbsoluteDateTime(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}
export function formatNativeQueueStatus(status: string): string {
  return status;
}
export function safeParseQueuePayloadWithMetadata(inputJson: string): {
  contactId?: string;
  channelName?: string;
  mentionedAgentIds?: string[];
} {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return {
      contactId: typeof parsed.contactId === "string" ? parsed.contactId : undefined,
      channelName: typeof parsed.channelName === "string" ? parsed.channelName : undefined,
      mentionedAgentIds: Array.isArray(parsed.mentionedAgentIds)
        ? parsed.mentionedAgentIds.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}
export function isMessageRelevantToAgent(message: WorkspaceMessage, agentName: string, tasks: TaskRecord[]): boolean {
  if (sameText(message.speaker, agentName) || message.speaker.includes(agentName)) {
    return true;
  }

  if (message.mentions?.some((mention) =>
    mention.mentionType === "agent" && (sameText(mention.agentId, agentName) || sameText(mention.label, agentName))
  )) {
    return true;
  }

  for (const task of tasks) {
    if (task.title.length > 0 && message.summary.includes(task.title)) {
      return true;
    }
  }

  return false;
}
