// 知识提案（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type KnowledgeProposalOperation,
} from "./agent-access.ts";
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";

export type KnowledgeProposalStatus = "pending" | "approved" | "rejected" | "stale" | "cancelled";

export interface KnowledgeProposalRecord {
  id: string;
  workspaceId: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
  sourceAgentName: string;
  operation: KnowledgeProposalOperation;
  status: KnowledgeProposalStatus;
  title: string;
  contentMarkdown: string;
  summary?: string;
  reason?: string;
  tags: string[];
  parentId?: string;
  assignmentMode: KnowledgeAssignmentMode;
  assignedEmployeeNames: string[];
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
  createdKnowledgePageId?: string;
  approvalId?: string;
  decidedByUserId?: string;
  decidedAt?: string;
  reviewerComment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResetKnowledgeProposalsResult {
  removedKnowledgeProposalRows: number;
}
