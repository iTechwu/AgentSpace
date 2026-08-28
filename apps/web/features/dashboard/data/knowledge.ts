// dashboard 知识页数据装配（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { buildChannelWorkspaceArtifacts, buildKnowledgeDocumentPageRecords, getVisibleWorkspaceChannelNames, isWorkspaceManagerRole } from "../dashboard-view-builders";
import type { AgentKnowledgePageRecord, KnowledgeAgentOption, KnowledgeAssignedAgentRecord, KnowledgeAssignmentStats, KnowledgeDocumentPageRecord, KnowledgePageRecord, WorkspaceAgentKnowledgeRecord } from "../data-types";
import { DEFAULT_WORKSPACE_ID, listCapabilityRequestsSync } from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";
import type { ActiveEmployee, DofeAgentState, KnowledgeAssignmentMode, KnowledgePage } from "@dofe-agent/domain/workspace";
import { buildLegacyAgentIdForEmployeeName } from "@dofe-agent/services/employees";
import { listKnowledgeAssignmentPoliciesSync, listKnowledgeAssignmentsSync, reapStuckParseTasksSync } from "@dofe-agent/services/knowledge";
import { limitLoadtestDashboardPayload } from "./agents.ts";
import { AGENT_ASSIGNABLE_KNOWLEDGE_LIMIT, AGENT_KNOWLEDGE_PREVIEW_LIMIT, KNOWLEDGE_PAGE_PREVIEW_LIMIT, listKnowledgeAssignmentPoliciesCached, listKnowledgeAssignmentsCached, listQueuedTasksCached, readWorkspaceStateCached } from "./cached.ts";

export interface KnowledgePageData {
  workspaceId: string;
  pages: KnowledgePageRecord[];
  totalCount: number;
  rootCount: number;
  agentOptions: KnowledgeAgentOption[];
  assignmentStats: KnowledgeAssignmentStats;
  materials: Array<{ id: string; source: string; preview?: string }>;
  documentPages: KnowledgeDocumentPageRecord[];
  documentCount: number;
  linkedDocumentCount: number;
  parseTasks: KnowledgeParseTask[];
}
export interface KnowledgeParseTask {
  id: string;
  fileName: string;
  status: "pending" | "approved" | "running" | "completed" | "failed" | "cancelled" | "rejected";
  intent: "auto_deposit" | "document_only";
  mediaType: string;
  sizeBytes: number;
  attachmentId: string;
  linkedKnowledgePageId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}
export function getKnowledgePageData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): KnowledgePageData {
  const state = readWorkspaceStateCached(workspaceId);
  const knowledgePolicies = listKnowledgeAssignmentPoliciesCached(workspaceId);
  const knowledgeAssignments = listKnowledgeAssignmentsCached(workspaceId);
  const knowledgePolicyIndex = new Map(knowledgePolicies.map((policy) => [policy.knowledgePageId, policy]));
  const agentOptions = buildKnowledgeAgentOptions(state);
  const knowledgePageRecords = buildKnowledgePageRecords(
    state.knowledgePages,
    agentOptions,
    knowledgePolicyIndex,
    knowledgeAssignments,
  );
  const queuedTasks = listQueuedTasksCached(workspaceId);
  const visibleChannelNames = getVisibleWorkspaceChannelNames(state, currentUserDisplayName);
  const workspaceArtifacts = buildChannelWorkspaceArtifacts(
    state,
    queuedTasks,
    currentUserDisplayName,
    visibleChannelNames,
    workspaceId,
  );
  const documentPages = buildKnowledgeDocumentPageRecords(
    workspaceArtifacts.documents,
    workspaceArtifacts.channelFiles,
    state.knowledgePages,
  );
  const knowledgePagePreview = limitLoadtestDashboardPayload(knowledgePageRecords, KNOWLEDGE_PAGE_PREVIEW_LIMIT);
  const parseTasks = buildKnowledgeParseTasks(currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole);

  return {
    workspaceId,
    pages: knowledgePagePreview,
    totalCount: state.knowledgePages.length,
    rootCount: state.knowledgePages.filter((page) => page.parentId === null).length,
    agentOptions,
    assignmentStats: buildKnowledgeAssignmentStats(knowledgePageRecords, state.knowledgePages),
    materials: state.materials.map((m) => ({
      id: m.id ?? "",
      source: m.source,
      preview: m.preview,
    })),
    documentPages,
    documentCount: documentPages.length,
    linkedDocumentCount: documentPages.filter((document) => document.linkedKnowledgePages.length > 0).length,
    parseTasks,
  };
}
export function buildKnowledgeParseTasks(
  currentUserDisplayName: string | undefined,
  workspaceId: string,
  currentUserId: string | undefined,
  currentMembershipRole: WorkspaceRole | undefined,
): KnowledgeParseTask[] {
  // 先回收卡住的解析任务（进程崩溃/重启后 fire-and-forget 解析留下的永久 running 行），
  // 再读取，避免 UI 把已死的任务渲染成永久转圈。
  reapStuckParseTasksSync(workspaceId);
  const requests = listCapabilityRequestsSync({
    workspaceId,
    packageKind: "service",
    limit: 50,
  }).filter((request) => request.requestedAction === "parse");
  const isManager = isWorkspaceManagerRole(currentMembershipRole);
  return requests
    .filter((request) => {
      // 管理员全可见；匿名（无 userId，如搜索/测试）全可见兜底；
      // 普通成员只看自己提交的任务（按真实 userId 匹配，而非 displayName）。
      if (isManager || !currentUserId) return true;
      return request.requestedByUserId === currentUserId;
    })
    .map((request) => {
      let metadata: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(request.metadataJson);
        if (parsed && typeof parsed === "object") {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = {};
      }
      const intent = metadata.intent === "document_only" ? "document_only" : "auto_deposit";
      const warnings = Array.isArray(metadata.warnings)
        ? (metadata.warnings as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const sizeBytes = typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : 0;
      return {
        id: request.id,
        fileName: request.packageDisplayName,
        status: request.status,
        intent,
        mediaType: typeof metadata.mediaType === "string" ? metadata.mediaType : "",
        sizeBytes,
        attachmentId: typeof metadata.attachmentId === "string" ? metadata.attachmentId : "",
        linkedKnowledgePageId: request.linkedKnowledgePageId,
        lastErrorCode: request.lastErrorCode,
        lastErrorMessage: request.lastErrorMessage,
        warnings,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      } satisfies KnowledgeParseTask;
    });
}
export function buildKnowledgeAgentOptions(state: DofeAgentState): KnowledgeAgentOption[] {
  return state.activeEmployees.map((employee) => ({
    id: buildLegacyAgentIdForEmployeeName(employee.name),
    employeeName: employee.name,
    name: employee.remarkName?.trim() || employee.name,
    subtitle: employee.name,
    status: "linked",
  }));
}
export function buildKnowledgePageRecords(
  pages: KnowledgePage[],
  agentOptions: KnowledgeAgentOption[],
  policyIndex: Map<string, ReturnType<typeof listKnowledgeAssignmentPoliciesSync>[number]>,
  assignments: ReturnType<typeof listKnowledgeAssignmentsSync>,
): KnowledgePageRecord[] {
  const agentByEmployeeName = new Map(agentOptions.map((agent) => [agent.employeeName, agent]));
  const assignmentsByPageId = new Map<string, ReturnType<typeof listKnowledgeAssignmentsSync>>();
  for (const assignment of assignments) {
    const next = assignmentsByPageId.get(assignment.knowledgePageId) ?? [];
    next.push(assignment);
    assignmentsByPageId.set(assignment.knowledgePageId, next);
  }

  return pages.map((page) => {
    const policy = policyIndex.get(page.id);
    const assignmentMode = policy?.assignmentMode ?? page.assignmentMode ?? "all_agents";
    const pageAssignments = assignmentsByPageId.get(page.id) ?? [];
    const assignedAgents = pageAssignments.flatMap((assignment) => {
      const agent = agentByEmployeeName.get(assignment.employeeName);
      if (!agent) {
        return [];
      }
      return [{
        ...agent,
        assignedAt: assignment.createdAt,
        assignedBy: assignment.createdBy,
      } satisfies KnowledgeAssignedAgentRecord];
    });
    const effectiveAgentCount = assignmentMode === "all_agents" ? agentOptions.length : assignedAgents.length;

    return {
      ...page,
      assignmentMode,
      assignmentUpdatedAt: policy?.updatedAt ?? page.assignmentUpdatedAt,
      assignmentUpdatedBy: policy?.updatedBy ?? page.assignmentUpdatedBy,
      assignedAgents,
      assignedAgentIds: assignedAgents.map((agent) => agent.id),
      assignedEmployeeNames: assignedAgents.map((agent) => agent.employeeName),
      assignedAgentCount: assignedAgents.length,
      effectiveAgentCount,
      assignmentSummary:
        assignmentMode === "all_agents"
          ? `${effectiveAgentCount} agents`
          : assignedAgents.length > 0
            ? assignedAgents.map((agent) => agent.name).join(", ")
            : "No agents assigned",
    };
  });
}
export function buildKnowledgeAssignmentStats(
  records: KnowledgePageRecord[],
  sourcePages: KnowledgePage[],
): KnowledgeAssignmentStats {
  return {
    allAgentsPageCount: records.filter((page) => page.assignmentMode === "all_agents").length,
    selectedAgentsPageCount: records.filter((page) => page.assignmentMode === "selected_agents").length,
    unconfiguredPageCount: sourcePages.filter((page) => !page.assignmentMode).length,
  };
}
export function buildWorkspaceAgentKnowledgeRecord(
  employee: ActiveEmployee,
  pages: KnowledgePage[],
  policyIndex: Map<string, ReturnType<typeof listKnowledgeAssignmentPoliciesSync>[number]>,
  assignments: ReturnType<typeof listKnowledgeAssignmentsSync>,
): WorkspaceAgentKnowledgeRecord {
  const directPageIds = assignments
    .filter((assignment) => assignment.employeeName === employee.name)
    .map((assignment) => assignment.knowledgePageId);
  const directPageIdSet = new Set(directPageIds);
  const inheritedPages: AgentKnowledgePageRecord[] = [];
  const directPages: AgentKnowledgePageRecord[] = [];
  const assignablePages: AgentKnowledgePageRecord[] = [];

  for (const page of pages) {
    const assignmentMode = policyIndex.get(page.id)?.assignmentMode ?? page.assignmentMode ?? "all_agents";
    const record = buildAgentKnowledgePageRecord(page, assignmentMode);
    if (assignmentMode === "all_agents") {
      inheritedPages.push(record);
      continue;
    }
    if (directPageIdSet.has(page.id)) {
      directPages.push(record);
      continue;
    }
    assignablePages.push(record);
  }

  return {
    directPageIds,
    inheritedPages: limitLoadtestDashboardPayload(inheritedPages, AGENT_KNOWLEDGE_PREVIEW_LIMIT),
    directPages: limitLoadtestDashboardPayload(directPages, AGENT_KNOWLEDGE_PREVIEW_LIMIT),
    assignablePages: limitLoadtestDashboardPayload(assignablePages, AGENT_ASSIGNABLE_KNOWLEDGE_LIMIT),
    totalAvailableCount: inheritedPages.length + directPages.length,
    directCount: directPages.length,
    inheritedCount: inheritedPages.length,
  };
}
export function buildAgentKnowledgePageRecord(
  page: KnowledgePage,
  assignmentMode: KnowledgeAssignmentMode,
): AgentKnowledgePageRecord {
  return {
    id: page.id,
    title: page.title,
    tags: page.tags,
    updatedAt: page.updatedAt,
    assignmentMode,
    sourceLabel: page.sourceChannelDocumentId
      ? "Shared document"
      : page.sourceAttachmentId
        ? "Shared attachment"
        : undefined,
  };
}

// ── Performance ──
