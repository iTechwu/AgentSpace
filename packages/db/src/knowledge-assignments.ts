import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";
import type {
  StoredAgentKnowledgePageRecord,
  StoredKnowledgeAssignmentPolicyRecord,
} from "./types.ts";

export function listStoredKnowledgeAssignmentPoliciesSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredKnowledgeAssignmentPolicyRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
       workspace_id AS workspaceId,
       knowledge_page_id AS knowledgePageId,
       assignment_mode AS assignmentMode,
       updated_at AS updatedAt,
       updated_by AS updatedBy
     FROM knowledge_page_assignment_policy
     WHERE workspace_id = ?
     ORDER BY updated_at DESC, knowledge_page_id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapStoredKnowledgeAssignmentPolicyRecord(row))
    .filter((row): row is StoredKnowledgeAssignmentPolicyRecord => row !== null);
}

export function setStoredKnowledgePageAssignmentPolicySync(input: {
  workspaceId?: string;
  knowledgePageId: string;
  assignmentMode: KnowledgeAssignmentMode;
  updatedBy?: string;
  updatedAt?: string;
}): StoredKnowledgeAssignmentPolicyRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const updatedBy = input.updatedBy?.trim() ?? "";

  db.prepare(
    `INSERT INTO knowledge_page_assignment_policy (
       workspace_id,
       knowledge_page_id,
       assignment_mode,
       updated_at,
       updated_by
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, knowledge_page_id) DO UPDATE SET
       assignment_mode = excluded.assignment_mode,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(workspaceId, input.knowledgePageId, input.assignmentMode, updatedAt, updatedBy);

  return {
    workspaceId,
    knowledgePageId: input.knowledgePageId,
    assignmentMode: input.assignmentMode,
    updatedAt,
    updatedBy,
  };
}

export function deleteStoredKnowledgeAssignmentPoliciesForPagesSync(
  knowledgePageIds: string[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): number {
  const pageIds = normalizeIds(knowledgePageIds);
  if (pageIds.length === 0) {
    return 0;
  }

  const db = getDatabase();
  let removed = 0;
  withTransaction(db, () => {
    for (const pageId of pageIds) {
      removed += db.prepare(
        `DELETE FROM knowledge_page_assignment_policy
         WHERE workspace_id = ? AND knowledge_page_id = ?`,
      ).run(workspaceId, pageId).changes;
    }
  });
  return removed;
}

export function listStoredAgentKnowledgePageAssignmentsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredAgentKnowledgePageRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
       workspace_id AS workspaceId,
       agent_id AS agentId,
       employee_name AS employeeName,
       knowledge_page_id AS knowledgePageId,
       created_at AS createdAt,
       created_by AS createdBy
     FROM agent_knowledge_page
     WHERE workspace_id = ?
     ORDER BY LOWER(employee_name) ASC, employee_name ASC, created_at ASC, knowledge_page_id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapStoredAgentKnowledgePageRecord(row))
    .filter((row): row is StoredAgentKnowledgePageRecord => row !== null);
}

export function listStoredKnowledgeAssignmentsByPageIdSync(
  knowledgePageId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredAgentKnowledgePageRecord[] {
  return listStoredAgentKnowledgePageAssignmentsSync(workspaceId)
    .filter((assignment) => assignment.knowledgePageId === knowledgePageId);
}

export function listStoredKnowledgeAssignmentsByEmployeeSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredAgentKnowledgePageRecord[] {
  return listStoredAgentKnowledgePageAssignmentsSync(workspaceId)
    .filter((assignment) => assignment.employeeName === employeeName);
}

export function setStoredKnowledgePageAssignedEmployeesSync(input: {
  workspaceId?: string;
  knowledgePageId: string;
  employeeNames: string[];
  createdBy?: string;
}): void {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const createdBy = input.createdBy?.trim() ?? "";
  const employeeNames = normalizeIds(input.employeeNames);

  withTransaction(db, () => {
    db.prepare(
      `DELETE FROM agent_knowledge_page
       WHERE workspace_id = ? AND knowledge_page_id = ?`,
    ).run(workspaceId, input.knowledgePageId);

    for (const employeeName of employeeNames) {
      db.prepare(
        `INSERT INTO agent_knowledge_page (
           workspace_id,
           agent_id,
           employee_name,
           knowledge_page_id,
           created_at,
           created_by
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(workspaceId, buildLegacyAgentId(employeeName), employeeName, input.knowledgePageId, now, createdBy);
    }
  });
}

export function setStoredEmployeeKnowledgePageAssignmentsSync(input: {
  workspaceId?: string;
  employeeName: string;
  knowledgePageIds: string[];
  createdBy?: string;
}): void {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const createdBy = input.createdBy?.trim() ?? "";
  const knowledgePageIds = normalizeIds(input.knowledgePageIds);

  withTransaction(db, () => {
    db.prepare(
      `DELETE FROM agent_knowledge_page
       WHERE workspace_id = ? AND employee_name = ?`,
    ).run(workspaceId, input.employeeName);

    for (const knowledgePageId of knowledgePageIds) {
      db.prepare(
        `INSERT INTO agent_knowledge_page (
           workspace_id,
           agent_id,
           employee_name,
           knowledge_page_id,
           created_at,
           created_by
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(workspaceId, buildLegacyAgentId(input.employeeName), input.employeeName, knowledgePageId, now, createdBy);
    }
  });
}

export function deleteStoredKnowledgeAssignmentsForPagesSync(
  knowledgePageIds: string[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): number {
  const pageIds = normalizeIds(knowledgePageIds);
  if (pageIds.length === 0) {
    return 0;
  }

  const db = getDatabase();
  let removed = 0;
  withTransaction(db, () => {
    for (const pageId of pageIds) {
      removed += db.prepare(
        `DELETE FROM agent_knowledge_page
         WHERE workspace_id = ? AND knowledge_page_id = ?`,
      ).run(workspaceId, pageId).changes;
    }
  });
  return removed;
}

export function deleteStoredKnowledgeAssignmentsForEmployeeSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): number {
  const db = getDatabase();
  return db.prepare(
    `DELETE FROM agent_knowledge_page
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run(workspaceId, employeeName).changes;
}

export function resetStoredKnowledgeAssignmentsSync(workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  withTransaction(db, () => {
    db.prepare("DELETE FROM agent_knowledge_page WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM knowledge_page_assignment_policy WHERE workspace_id = ?").run(workspaceId);
  });
}

function mapStoredKnowledgeAssignmentPolicyRecord(
  value: Record<string, unknown>,
): StoredKnowledgeAssignmentPolicyRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.knowledgePageId !== "string" ||
    !isKnowledgeAssignmentMode(value.assignmentMode) ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    knowledgePageId: value.knowledgePageId,
    assignmentMode: value.assignmentMode,
    updatedAt: value.updatedAt,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : "",
  };
}

function mapStoredAgentKnowledgePageRecord(value: Record<string, unknown>): StoredAgentKnowledgePageRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.knowledgePageId !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    agentId: typeof value.agentId === "string" ? value.agentId : undefined,
    employeeName: value.employeeName,
    knowledgePageId: value.knowledgePageId,
    createdAt: value.createdAt,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "",
  };
}

function isKnowledgeAssignmentMode(value: unknown): value is KnowledgeAssignmentMode {
  return value === "all_agents" || value === "selected_agents";
}

function normalizeIds(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || result.includes(trimmed)) {
      continue;
    }
    result.push(trimmed);
  }
  return result;
}

function buildLegacyAgentId(employeeName: string): string {
  return `agent:${employeeName.trim()}`;
}
