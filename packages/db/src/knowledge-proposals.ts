import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  KnowledgeProposalOperation,
  KnowledgeProposalRecord,
  KnowledgeProposalStatus,
  ResetKnowledgeProposalsResult,
} from "./types.ts";
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";

export interface CreateKnowledgeProposalInput {
  workspaceId?: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
  sourceAgentName: string;
  operation: KnowledgeProposalOperation;
  title: string;
  contentMarkdown: string;
  summary?: string;
  reason?: string;
  tags?: string[];
  parentId?: string | null;
  assignmentMode?: KnowledgeAssignmentMode;
  assignedEmployeeNames?: string[];
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
  approvalId?: string;
}

export interface ListKnowledgeProposalsOptions {
  statuses?: KnowledgeProposalStatus[];
  sourceTaskQueueId?: string;
  sourceAgentName?: string;
  approvalId?: string;
}

export interface DecideKnowledgeProposalInput {
  proposalId: string;
  workspaceId?: string;
  status: Exclude<KnowledgeProposalStatus, "pending">;
  decidedByUserId?: string;
  reviewerComment?: string;
  createdKnowledgePageId?: string;
}

export function createKnowledgeProposalSync(input: CreateKnowledgeProposalInput): KnowledgeProposalRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `knowledge-proposal-${randomLikeId()}`;
  const assignmentMode = input.assignmentMode ?? "selected_agents";

  db.prepare(
    `INSERT INTO knowledge_proposal (
      id,
      workspace_id,
      source_task_queue_id,
      source_channel_name,
      source_agent_name,
      operation,
      status,
      title,
      content_markdown,
      summary,
      reason,
      tags_json,
      parent_id,
      assignment_mode,
      assigned_employee_names_json,
      target_knowledge_page_id,
      base_updated_at,
      created_knowledge_page_id,
      approval_id,
      decided_by_user_id,
      decided_at,
      reviewer_comment,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    workspaceId,
    requireTrimmed(input.sourceTaskQueueId, "sourceTaskQueueId"),
    normalizeOptional(input.sourceChannelName) ?? null,
    requireTrimmed(input.sourceAgentName, "sourceAgentName"),
    input.operation,
    requireTrimmed(input.title, "title"),
    input.contentMarkdown,
    normalizeOptional(input.summary) ?? null,
    normalizeOptional(input.reason) ?? null,
    JSON.stringify(normalizeStringList(input.tags)),
    normalizeOptional(input.parentId ?? undefined) ?? null,
    assignmentMode,
    JSON.stringify(normalizeStringList(input.assignedEmployeeNames)),
    normalizeOptional(input.targetKnowledgePageId) ?? null,
    normalizeOptional(input.baseUpdatedAt) ?? null,
    normalizeOptional(input.approvalId) ?? null,
    now,
    now,
  );

  const record = readKnowledgeProposalSync(id, workspaceId);
  if (!record) {
    throw new Error(`Knowledge proposal "${id}" could not be read after write.`);
  }
  return record;
}

export function readKnowledgeProposalSync(
  proposalId: string,
  workspaceId?: string,
): KnowledgeProposalRecord | null {
  const db = getDatabase();
  const row = workspaceId
    ? db.prepare(knowledgeProposalSelectSql("id = ? AND workspace_id = ?")).get(proposalId, workspaceId)
    : db.prepare(knowledgeProposalSelectSql("id = ?")).get(proposalId);
  return row ? mapKnowledgeProposalRecord(row as Record<string, unknown>) : null;
}

export function readKnowledgeProposalByApprovalIdSync(
  approvalId: string,
  workspaceId?: string,
): KnowledgeProposalRecord | null {
  const db = getDatabase();
  const row = workspaceId
    ? db.prepare(knowledgeProposalSelectSql("approval_id = ? AND workspace_id = ?")).get(approvalId, workspaceId)
    : db.prepare(knowledgeProposalSelectSql("approval_id = ?")).get(approvalId);
  return row ? mapKnowledgeProposalRecord(row as Record<string, unknown>) : null;
}

export function listKnowledgeProposalsSync(
  workspaceId: string,
  options?: ListKnowledgeProposalsOptions,
): KnowledgeProposalRecord[] {
  const conditions = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];

  if (options?.statuses?.length) {
    conditions.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  if (options?.sourceTaskQueueId?.trim()) {
    conditions.push("source_task_queue_id = ?");
    params.push(options.sourceTaskQueueId.trim());
  }
  if (options?.sourceAgentName?.trim()) {
    conditions.push("source_agent_name = ?");
    params.push(options.sourceAgentName.trim());
  }
  if (options?.approvalId?.trim()) {
    conditions.push("approval_id = ?");
    params.push(options.approvalId.trim());
  }

  const rows = getDatabase().prepare(
    `${knowledgeProposalSelectSql(conditions.join(" AND "))}
     ORDER BY created_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows
    .map(mapKnowledgeProposalRecord)
    .filter((record): record is KnowledgeProposalRecord => record !== null);
}

export function updateKnowledgeProposalApprovalIdSync(input: {
  proposalId: string;
  workspaceId?: string;
  approvalId: string;
}): KnowledgeProposalRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE knowledge_proposal
     SET approval_id = ?,
         updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(requireTrimmed(input.approvalId, "approvalId"), now, input.proposalId, workspaceId);

  const updated = readKnowledgeProposalSync(input.proposalId, workspaceId);
  if (!updated) {
    throw new Error(`Knowledge proposal "${input.proposalId}" does not exist.`);
  }
  return updated;
}

export function decideKnowledgeProposalSync(input: DecideKnowledgeProposalInput): KnowledgeProposalRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE knowledge_proposal
     SET status = ?,
         created_knowledge_page_id = COALESCE(?, created_knowledge_page_id),
         decided_by_user_id = COALESCE(?, decided_by_user_id),
         decided_at = ?,
         reviewer_comment = ?,
         updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(
    input.status,
    normalizeOptional(input.createdKnowledgePageId) ?? null,
    normalizeOptional(input.decidedByUserId) ?? null,
    now,
    normalizeOptional(input.reviewerComment) ?? null,
    now,
    input.proposalId,
    workspaceId,
  );

  const updated = readKnowledgeProposalSync(input.proposalId, workspaceId);
  if (!updated) {
    throw new Error(`Knowledge proposal "${input.proposalId}" does not exist.`);
  }
  return updated;
}

export function resetKnowledgeProposalsSync(workspaceId: string): ResetKnowledgeProposalsResult {
  const result = getDatabase()
    .prepare("DELETE FROM knowledge_proposal WHERE workspace_id = ?")
    .run(workspaceId);

  return {
    removedKnowledgeProposalRows: Number(result.changes),
  };
}

function knowledgeProposalSelectSql(where: string): string {
  return `SELECT
      id,
      workspace_id AS workspaceId,
      source_task_queue_id AS sourceTaskQueueId,
      source_channel_name AS sourceChannelName,
      source_agent_name AS sourceAgentName,
      operation,
      status,
      title,
      content_markdown AS contentMarkdown,
      summary,
      reason,
      tags_json AS tagsJson,
      parent_id AS parentId,
      assignment_mode AS assignmentMode,
      assigned_employee_names_json AS assignedEmployeeNamesJson,
      target_knowledge_page_id AS targetKnowledgePageId,
      base_updated_at AS baseUpdatedAt,
      created_knowledge_page_id AS createdKnowledgePageId,
      approval_id AS approvalId,
      decided_by_user_id AS decidedByUserId,
      decided_at AS decidedAt,
      reviewer_comment AS reviewerComment,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM knowledge_proposal
     WHERE ${where}`;
}

function mapKnowledgeProposalRecord(value: Record<string, unknown>): KnowledgeProposalRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.sourceTaskQueueId !== "string" ||
    typeof value.sourceAgentName !== "string" ||
    !isKnowledgeProposalOperation(value.operation) ||
    !isKnowledgeProposalStatus(value.status) ||
    typeof value.title !== "string" ||
    typeof value.contentMarkdown !== "string" ||
    !isKnowledgeAssignmentMode(value.assignmentMode) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    sourceTaskQueueId: value.sourceTaskQueueId,
    sourceChannelName: optionalString(value.sourceChannelName),
    sourceAgentName: value.sourceAgentName,
    operation: value.operation,
    status: value.status,
    title: value.title,
    contentMarkdown: value.contentMarkdown,
    summary: optionalString(value.summary),
    reason: optionalString(value.reason),
    tags: parseStringJsonArray(value.tagsJson),
    parentId: optionalString(value.parentId),
    assignmentMode: value.assignmentMode,
    assignedEmployeeNames: parseStringJsonArray(value.assignedEmployeeNamesJson),
    targetKnowledgePageId: optionalString(value.targetKnowledgePageId),
    baseUpdatedAt: optionalString(value.baseUpdatedAt),
    createdKnowledgePageId: optionalString(value.createdKnowledgePageId),
    approvalId: optionalString(value.approvalId),
    decidedByUserId: optionalString(value.decidedByUserId),
    decidedAt: optionalString(value.decidedAt),
    reviewerComment: optionalString(value.reviewerComment),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isKnowledgeProposalOperation(value: unknown): value is KnowledgeProposalOperation {
  return value === "create" || value === "update";
}

function isKnowledgeProposalStatus(value: unknown): value is KnowledgeProposalStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "stale" || value === "cancelled";
}

function isKnowledgeAssignmentMode(value: unknown): value is KnowledgeAssignmentMode {
  return value === "all_agents" || value === "selected_agents";
}

function parseStringJsonArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return normalizeStringList(parsed);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed && !result.some((existing) => existing.localeCompare(trimmed, "zh-CN", { sensitivity: "base" }) === 0)) {
      result.push(trimmed);
    }
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}
