// dashboard 性能/数据表/自动化/日历/模板页（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import type { ChannelDocumentRunRecord } from "../data-types";
import { DEFAULT_WORKSPACE_ID, listWorkflowDefinitionsSync, readWorkflowTriggerForWorkflowSync } from "@dofe-agent/db";
import type { AutomationRule, DataTable, ScheduledTask, Template } from "@dofe-agent/domain/workspace";
import { projectLegacySchedulesForCutover, readWorkflowCutoverModeSync } from "@dofe-agent/services";
import type { PerformanceDashboardData } from "@dofe-agent/services";
import { getPerformanceDashboardDataCached, listQueuedTasksCached, readWorkspaceStateCached } from "./cached.ts";

export function getPerformancePageData(workspaceId = DEFAULT_WORKSPACE_ID): Promise<PerformanceDashboardData> {
  return getPerformanceDashboardDataCached(workspaceId);
}

// ── Data Tables (#25) ──
export interface DataTablesPageData {
  tables: DataTable[];
  totalCount: number;
  activeCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}
export function getDataTablesPageData(workspaceId = DEFAULT_WORKSPACE_ID): DataTablesPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const tables = state.dataTables ?? [];

  return {
    tables,
    totalCount: tables.length,
    activeCount: tables.filter((t) => t.status === "active").length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Automations (#27) ──
export interface AutomationsPageData {
  rules: AutomationRule[];
  documentRuns: ChannelDocumentRunRecord[];
  autoContinuationRuns: AutoContinuationRunRecord[];
  totalCount: number;
  enabledCount: number;
  documentRunCount: number;
  autoContinuationRunCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}
export interface AutoContinuationRunRecord {
  id: string;
  channelName: string;
  agentId: string;
  contactId?: string;
  status: "active" | "expired" | "stopped";
  startedAt: string;
  until: string;
  instruction: string;
  iteration: number;
  lastContinuedAt?: string;
  updatedAt: string;
  lastTaskQueueId?: string;
  lastTaskStatus?: string;
}
export function getAutomationsPageData(workspaceId = DEFAULT_WORKSPACE_ID): AutomationsPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const queuedTaskById = new Map(listQueuedTasksCached(workspaceId).map((task) => [task.id, task]));
  const rules = state.automationRules ?? [];
  const documentRuns = (state.channelDocumentRuns ?? [])
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((run) => ({
      id: run.id,
      channelName: run.channelName,
      sourceMessageId: run.sourceMessageId,
      sourceSummary: run.sourceSummary,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      steps: (state.channelDocumentRunSteps ?? [])
        .filter((step) => step.runId === run.id)
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
        .map((step) => ({
          id: step.id,
          agentId: step.agentId,
          agentLabel: step.agentLabel,
          instruction: step.instruction,
          status: step.status,
          handoffKind: step.handoffKind,
          documentId: step.documentId,
          documentVersionId: step.documentVersionId,
          lastError: step.lastError,
          lastWarning: step.lastWarning,
        })),
    }) satisfies ChannelDocumentRunRecord);
  const autoContinuationRuns = (state.conversationExecutionWorkspaces ?? [])
    .filter((workspace) => Boolean(workspace.autoContinuation))
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((workspace) => ({
      id: `${workspace.channelName}:${workspace.agentId}:${workspace.contactId ?? ""}:${workspace.autoContinuation!.startedAt}`,
      channelName: workspace.channelName,
      agentId: workspace.agentId,
      contactId: workspace.contactId,
      status: workspace.autoContinuation!.status,
      startedAt: workspace.autoContinuation!.startedAt,
      until: workspace.autoContinuation!.until,
      instruction: workspace.autoContinuation!.instruction,
      iteration: workspace.autoContinuation!.iteration,
      lastContinuedAt: workspace.autoContinuation!.lastContinuedAt,
      updatedAt: workspace.updatedAt,
      lastTaskQueueId: workspace.lastTaskQueueId,
      lastTaskStatus: workspace.lastTaskQueueId ? queuedTaskById.get(workspace.lastTaskQueueId)?.status : undefined,
    }) satisfies AutoContinuationRunRecord);

  return {
    rules,
    documentRuns,
    autoContinuationRuns,
    totalCount: rules.length + 2,
    enabledCount: rules.filter((r) => r.enabled).length + 2,
    documentRunCount: documentRuns.length,
    autoContinuationRunCount: autoContinuationRuns.length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Calendar / Schedules (#28) ──
export interface CalendarPageData {
  scheduledTasks: Array<ScheduledTask & {
    sourceKind?: "legacy" | "workflow";
    migrationStatus?: "legacy" | "needs_migration" | "migrated";
    legacySourceId?: string;
    workflowId?: string;
  }>;
  totalCount: number;
  activeCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}
export function getCalendarPageData(workspaceId = DEFAULT_WORKSPACE_ID): CalendarPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const mode = readWorkflowCutoverModeSync(workspaceId);
  const workflows = mode === "legacy_only" ? [] : listWorkflowDefinitionsSync(workspaceId);
  const scheduledWorkflows = workflows.filter((workflow) => workflow.legacySourceType === "scheduled_task");
  const scheduledTasks = projectLegacySchedulesForCutover({
    mode,
    legacyTasks: state.scheduledTasks ?? [],
    workflows: scheduledWorkflows,
    triggers: scheduledWorkflows.flatMap((workflow) => {
      const trigger = readWorkflowTriggerForWorkflowSync(workflow.id, workspaceId);
      return trigger ? [trigger] : [];
    }),
  });

  return {
    scheduledTasks,
    totalCount: scheduledTasks.length,
    activeCount: scheduledTasks.filter((t) => t.status === "active").length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Templates (#29) ──
export interface TemplatesPageData {
  templates: Template[];
  totalCount: number;
  builtInCount: number;
  customCount: number;
}
export function getTemplatesPageData(workspaceId = DEFAULT_WORKSPACE_ID): TemplatesPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const templates = state.templates ?? [];

  return {
    templates,
    totalCount: templates.length,
    builtInCount: templates.filter((t) => t.builtIn).length,
    customCount: templates.filter((t) => !t.builtIn).length,
  };
}
