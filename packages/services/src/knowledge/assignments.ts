import {
  deleteStoredKnowledgeAssignmentPoliciesForPagesSync,
  deleteStoredKnowledgeAssignmentsForEmployeeSync,
  deleteStoredKnowledgeAssignmentsForPagesSync,
  DEFAULT_WORKSPACE_ID,
  listStoredAgentKnowledgePageAssignmentsSync,
  listStoredKnowledgeAssignmentPoliciesSync,
  listStoredKnowledgeAssignmentsByEmployeeSync,
  listStoredKnowledgeAssignmentsByPageIdSync,
  setStoredEmployeeKnowledgePageAssignmentsSync,
  setStoredKnowledgePageAssignedEmployeesSync,
  setStoredKnowledgePageAssignmentPolicySync,
  type StoredAgentKnowledgePageRecord,
  type StoredKnowledgeAssignmentPolicyRecord,
} from "@dofe-agent/db";
import type {
  DofeAgentState,
  KnowledgeAssignmentMode,
  KnowledgePage,
} from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, uniqueStringValues } from "../shared/helpers.ts";

export type KnowledgeAssignmentPolicy = StoredKnowledgeAssignmentPolicyRecord;
export type AgentKnowledgePageAssignment = StoredAgentKnowledgePageRecord;

export function listKnowledgeAssignmentPoliciesSync(
  workspaceId?: string,
): KnowledgeAssignmentPolicy[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  const storedPolicies = listStoredKnowledgeAssignmentPoliciesSync(workspaceId);
  const storedByPageId = new Map(storedPolicies.map((policy) => [policy.knowledgePageId, policy]));

  return state.knowledgePages.map((page) => {
    const stored = storedByPageId.get(page.id);
    return {
      workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
      knowledgePageId: page.id,
      assignmentMode: stored?.assignmentMode ?? page.assignmentMode ?? "all_agents",
      updatedAt: stored?.updatedAt ?? page.assignmentUpdatedAt ?? page.updatedAt,
      updatedBy: stored?.updatedBy ?? page.assignmentUpdatedBy ?? page.createdBy,
    };
  });
}

export function listKnowledgeAssignmentsSync(workspaceId?: string): AgentKnowledgePageAssignment[] {
  return listStoredAgentKnowledgePageAssignmentsSync(workspaceId);
}

export function listKnowledgeAssignmentsByPageIdSync(
  pageId: string,
  workspaceId?: string,
): AgentKnowledgePageAssignment[] {
  return listStoredKnowledgeAssignmentsByPageIdSync(pageId, workspaceId);
}

export function listKnowledgeAssignmentsByEmployeeSync(
  employeeName: string,
  workspaceId?: string,
): AgentKnowledgePageAssignment[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = resolveEmployee(state, employeeName);
  if (!employee) {
    return [];
  }
  return listStoredKnowledgeAssignmentsByEmployeeSync(employee.name, workspaceId);
}

export function listEmployeeKnowledgePageIdsSync(employeeName: string, workspaceId?: string): string[] {
  return listEmployeeKnowledgePagesSync(employeeName, workspaceId).map((page) => page.id);
}

export function listEmployeeKnowledgePagesSync(employeeName: string, workspaceId?: string): KnowledgePage[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = resolveEmployee(state, employeeName);
  if (!employee) {
    return [];
  }

  const policyByPageId = buildPolicyMap(state, workspaceId);
  const directlyAssignedIds = new Set(
    listStoredKnowledgeAssignmentsByEmployeeSync(employee.name, workspaceId)
      .map((assignment) => assignment.knowledgePageId),
  );

  return state.knowledgePages.filter((page) => {
    const mode = policyByPageId.get(page.id)?.assignmentMode ?? page.assignmentMode ?? "all_agents";
    return mode === "all_agents" || directlyAssignedIds.has(page.id);
  });
}

export function setKnowledgePageAssignmentModeSync(
  pageId: string,
  assignmentMode: KnowledgeAssignmentMode,
  actor = "system",
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const page = resolvePage(state, pageId);
  if (!page) {
    throw new Error(`Knowledge page "${pageId}" does not exist.`);
  }

  const now = new Date().toISOString();
  page.assignmentMode = assignmentMode;
  page.assignmentUpdatedAt = now;
  page.assignmentUpdatedBy = actor.trim() || "system";
  page.updatedAt = now;

  setStoredKnowledgePageAssignmentPolicySync({
    workspaceId,
    knowledgePageId: page.id,
    assignmentMode,
    updatedAt: now,
    updatedBy: page.assignmentUpdatedBy,
  });

  if (assignmentMode === "all_agents") {
    deleteStoredKnowledgeAssignmentsForPagesSync([page.id], workspaceId);
  }

  state.ledger.unshift({
    title: "Knowledge assignment mode updated",
    note: `Knowledge page "${page.title}" assignment mode changed to ${assignmentMode}.`,
    code: "knowledge.assignment_mode_updated",
    data: {
      knowledge_page_id: page.id,
      assignment_mode: assignmentMode,
      actor,
    },
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function setKnowledgePageAssignedEmployeesSync(
  pageId: string,
  employeeNames: string[],
  actor = "system",
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const page = resolvePage(state, pageId);
  if (!page) {
    throw new Error(`Knowledge page "${pageId}" does not exist.`);
  }

  const employees = resolveEmployees(state, employeeNames);
  if (employees.length !== uniqueStringValues(employeeNames).length) {
    throw new Error("One or more agents do not exist.");
  }

  setStoredKnowledgePageAssignedEmployeesSync({
    workspaceId,
    knowledgePageId: page.id,
    employeeNames: employees.map((employee) => employee.name),
    createdBy: actor,
  });

  const now = new Date().toISOString();
  page.assignmentUpdatedAt = now;
  page.assignmentUpdatedBy = actor.trim() || "system";
  page.updatedAt = now;
  state.ledger.unshift({
    title: "Knowledge page assignments updated",
    note: `Knowledge page "${page.title}" was assigned to ${employees.length} agent(s).`,
    code: "knowledge.page_agents_updated",
    data: {
      knowledge_page_id: page.id,
      agent_count: String(employees.length),
      employee_names: employees.map((employee) => employee.name).join(", "),
      actor,
    },
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function setEmployeeKnowledgePageIdsSync(
  employeeName: string,
  pageIds: string[],
  actor = "system",
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = resolveEmployee(state, employeeName);
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  const normalizedPageIds = uniqueStringValues(pageIds);
  const pages = normalizedPageIds.map((pageId) => resolvePage(state, pageId));
  if (pages.some((page) => !page)) {
    throw new Error("One or more knowledge pages do not exist.");
  }

  const policyByPageId = buildPolicyMap(state, workspaceId);
  const directlyAssignablePageIds = pages
    .filter((page): page is KnowledgePage => Boolean(page))
    .filter((page) => (policyByPageId.get(page.id)?.assignmentMode ?? page.assignmentMode ?? "all_agents") === "selected_agents")
    .map((page) => page.id);

  if (directlyAssignablePageIds.length !== normalizedPageIds.length) {
    throw new Error("Only selected-agent knowledge pages can be assigned directly to an agent.");
  }

  setStoredEmployeeKnowledgePageAssignmentsSync({
    workspaceId,
    employeeName: employee.name,
    knowledgePageIds: directlyAssignablePageIds,
    createdBy: actor,
  });

  state.ledger.unshift({
    title: "Agent knowledge assignments updated",
    note: `${employee.remarkName ?? employee.name} knowledge assignments were updated with ${directlyAssignablePageIds.length} item(s).`,
    code: "agent.knowledge_updated",
    data: {
      employee_name: employee.name,
      knowledge_page_count: String(directlyAssignablePageIds.length),
      knowledge_page_ids: directlyAssignablePageIds.join(", "),
      actor,
    },
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function deleteKnowledgeAssignmentsForPageSync(
  pageIds: string[],
  workspaceId?: string,
): { removedPolicies: number; removedAssignments: number } {
  return {
    removedPolicies: deleteStoredKnowledgeAssignmentPoliciesForPagesSync(pageIds, workspaceId),
    removedAssignments: deleteStoredKnowledgeAssignmentsForPagesSync(pageIds, workspaceId),
  };
}

export function deleteKnowledgeAssignmentsForEmployeeSync(
  employeeName: string,
  workspaceId?: string,
): number {
  return deleteStoredKnowledgeAssignmentsForEmployeeSync(employeeName, workspaceId);
}

function buildPolicyMap(
  state: DofeAgentState,
  workspaceId?: string,
): Map<string, KnowledgeAssignmentPolicy> {
  const storedPolicies = listStoredKnowledgeAssignmentPoliciesSync(workspaceId);
  const map = new Map(storedPolicies.map((policy) => [policy.knowledgePageId, policy]));
  for (const page of state.knowledgePages) {
    if (!map.has(page.id)) {
      map.set(page.id, {
        workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
        knowledgePageId: page.id,
        assignmentMode: page.assignmentMode ?? "all_agents",
        updatedAt: page.assignmentUpdatedAt ?? page.updatedAt,
        updatedBy: page.assignmentUpdatedBy ?? page.createdBy,
      });
    }
  }
  return map;
}

function resolvePage(state: DofeAgentState, pageId: string): KnowledgePage | undefined {
  return state.knowledgePages.find((page) => page.id === pageId);
}

function resolveEmployee(
  state: DofeAgentState,
  employeeName: string,
): DofeAgentState["activeEmployees"][number] | undefined {
  return state.activeEmployees.find((employee) => sameValue(employee.name, employeeName));
}

function resolveEmployees(
  state: DofeAgentState,
  employeeNames: string[],
): DofeAgentState["activeEmployees"] {
  const result: DofeAgentState["activeEmployees"] = [];
  for (const employeeName of uniqueStringValues(employeeNames)) {
    const employee = resolveEmployee(state, employeeName);
    if (!employee) {
      continue;
    }
    if (!result.some((item) => sameValue(item.name, employee.name))) {
      result.push(employee);
    }
  }
  return result;
}
