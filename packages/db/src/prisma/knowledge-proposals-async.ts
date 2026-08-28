// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 knowledge-proposals-prisma.ts（同等接口，@prisma/client 真接入）。
//
// knowledge-proposals Phase 2 异步 primary（pg.Client 直连原型）：
// listKnowledgeProposalsAsync 通过 pg.Client 直连 PG 拉 knowledge_proposal 行；
// 切流 flag 由 env var 控制。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { ListKnowledgeProposalsOptions, KnowledgeProposalRecord } from "../knowledge-proposals.ts";

const VALID_OPERATIONS = new Set(["create", "update", "append", "archive", "assign"]);
const VALID_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "committed",
]);
const VALID_MODES = new Set(["explicit", "by_skill", "inherited", "manual"]);

export async function listKnowledgeProposalsAsync(
  workspaceId: string,
  options?: ListKnowledgeProposalsOptions,
): Promise<KnowledgeProposalRecord[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (options?.statuses?.length) {
    const placeholders = options.statuses.map((_, i) => `$${params.length + 1 + i}`).join(", ");
    conditions.push(`status IN (${placeholders})`);
    params.push(...options.statuses);
  }
  if (options?.sourceAgentName) {
    conditions.push(`source_agent_name = $${params.length + 1}`);
    params.push(options.sourceAgentName);
  }
  if (options?.approvalId) {
    conditions.push(`approval_id = $${params.length + 1}`);
    params.push(options.approvalId);
  }
  const sql = `SELECT id, workspace_id, source_task_queue_id, source_channel_name,
                     source_agent_name, operation, status, title, content_markdown,
                     summary, reason, tags, parent_id, assignment_mode,
                     assigned_employee_names, target_knowledge_page_id,
                     base_updated_at, created_knowledge_page_id, approval_id,
                     decided_by_user_id, decided_at, reviewer_comment,
                     created_at, updated_at
              FROM knowledge_proposal
              WHERE ${conditions.join(" AND ")}
              ORDER BY created_at DESC, id DESC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows
      .map((row) => mapRow(row))
      .filter((r): r is KnowledgeProposalRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isKnowledgeProposalsAsyncReadEnabled(): boolean {
  return process.env.KNOWLEDGE_PROPOSALS_ASYNC_READ_ENABLED === "1";
}

export function isKnowledgeProposalsShadowReadEnabled(): boolean {
  return process.env.KNOWLEDGE_PROPOSALS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  source_task_queue_id: string;
  source_channel_name: string | null;
  source_agent_name: string;
  operation: string;
  status: string;
  title: string;
  content_markdown: string;
  summary: string | null;
  reason: string | null;
  tags: unknown;
  parent_id: string | null;
  assignment_mode: string;
  assigned_employee_names: unknown;
  target_knowledge_page_id: string | null;
  base_updated_at: Date | string | null;
  created_knowledge_page_id: string | null;
  approval_id: string | null;
  decided_by_user_id: string | null;
  decided_at: Date | string | null;
  reviewer_comment: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): KnowledgeProposalRecord | null {
  if (!VALID_OPERATIONS.has(row.operation)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  if (!VALID_MODES.has(row.assignment_mode)) return null;
  const record: KnowledgeProposalRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceTaskQueueId: row.source_task_queue_id,
    sourceAgentName: row.source_agent_name,
    operation: row.operation as KnowledgeProposalRecord["operation"],
    status: row.status as KnowledgeProposalRecord["status"],
    title: row.title,
    contentMarkdown: row.content_markdown,
    tags: normalizeStringArray(row.tags),
    assignedEmployeeNames: normalizeStringArray(row.assigned_employee_names),
    assignmentMode: row.assignment_mode as KnowledgeProposalRecord["assignmentMode"],
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.source_channel_name !== null) record.sourceChannelName = row.source_channel_name;
  if (row.summary !== null) record.summary = row.summary;
  if (row.reason !== null) record.reason = row.reason;
  if (row.parent_id !== null) record.parentId = row.parent_id;
  if (row.target_knowledge_page_id !== null) record.targetKnowledgePageId = row.target_knowledge_page_id;
  if (row.base_updated_at !== null) record.baseUpdatedAt = toIsoString(row.base_updated_at);
  if (row.created_knowledge_page_id !== null) record.createdKnowledgePageId = row.created_knowledge_page_id;
  if (row.approval_id !== null) record.approvalId = row.approval_id;
  if (row.decided_by_user_id !== null) record.decidedByUserId = row.decided_by_user_id;
  if (row.decided_at !== null) record.decidedAt = toIsoString(row.decided_at);
  if (row.reviewer_comment !== null) record.reviewerComment = row.reviewer_comment;
  return record;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}