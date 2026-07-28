import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createKnowledgeProposalFromAgentSync,
  type CreateKnowledgeProposalFromAgentInput,
} from "@dofe-agent/services";
import {
  MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES,
  readKnowledgeProposalsManifest,
  type KnowledgeProposalManifestEntry,
} from "./runtime-output-manifests.ts";
import {
  getRuntimeOutputKnowledgeProposalsPath,
  RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH,
} from "./runtime-output.ts";

export interface AppliedKnowledgeProposal {
  proposalId?: string;
  approvalId?: string;
  title: string;
  operation: "create" | "update";
  status: "pending" | "failed";
  message: string;
}

export interface KnowledgeProposalOperationResult {
  warnings: string[];
  statusMessages: string[];
  knowledgeProposals: AppliedKnowledgeProposal[];
}

export function applyKnowledgeProposalOperations(input: {
  workDir: string;
  workspaceId: string;
  actorName: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
}): KnowledgeProposalOperationResult {
  const warnings: string[] = [];
  const statusMessages: string[] = [];
  const knowledgeProposals: AppliedKnowledgeProposal[] = [];
  const provenanceWarning = assertControlledKnowledgeProposalManifest(input.workDir);
  if (provenanceWarning) {
    warnings.push(provenanceWarning);
    statusMessages.push(provenanceWarning);
    return { warnings, statusMessages, knowledgeProposals };
  }

  for (const proposal of readKnowledgeProposalsManifest(input.workDir).proposals) {
    const result = applyKnowledgeProposalManifestEntry(input, proposal);
    knowledgeProposals.push(result);
    statusMessages.push(result.message);
    if (result.status === "failed") {
      warnings.push(result.message);
    }
  }

  return {
    warnings,
    statusMessages,
    knowledgeProposals,
  };
}

function assertControlledKnowledgeProposalManifest(workDir: string): string | undefined {
  const path = getRuntimeOutputKnowledgeProposalsPath(workDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    if ((parsed as { generatedBy?: unknown }).generatedBy === "dofe-agent-cli") {
      return undefined;
    }
    return `${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH} 已被拒绝：请使用 dofe-agent output knowledge propose-create/propose-update 生成受控 manifest，不要手写 JSON。`;
  } catch (error) {
    return `${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH} 已被拒绝：manifest 无法验证来源（${error instanceof Error ? error.message : String(error)}）。`;
  }
}

function applyKnowledgeProposalManifestEntry(
  context: {
    workDir: string;
    workspaceId: string;
    actorName: string;
    sourceTaskQueueId: string;
    sourceChannelName?: string;
  },
  entry: KnowledgeProposalManifestEntry,
): AppliedKnowledgeProposal {
  const title = entry.title?.trim() || "Untitled knowledge proposal";
  try {
    const contentMarkdown = readKnowledgeProposalContent(context.workDir, entry.contentPath);
    const input: CreateKnowledgeProposalFromAgentInput = {
      workspaceId: context.workspaceId,
      sourceTaskQueueId: context.sourceTaskQueueId,
      sourceChannelName: context.sourceChannelName,
      sourceAgentName: context.actorName,
      operation: entry.operation,
      title,
      contentMarkdown,
      summary: entry.summary,
      reason: entry.reason,
      tags: entry.tags,
      parentId: entry.parentId,
      assignmentMode: entry.assignmentMode,
      assignedEmployeeNames: entry.assignedEmployeeNames,
      assignToSelf: entry.assignToSelf,
      targetKnowledgePageId: entry.targetKnowledgePageId,
      baseUpdatedAt: entry.baseUpdatedAt,
    };
    const proposal = createKnowledgeProposalFromAgentSync(input);
    return {
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      title: proposal.title,
      operation: proposal.operation,
      status: "pending",
      message: `知识候选已提交审批：${proposal.title}`,
    };
  } catch (error) {
    return {
      title,
      operation: entry.operation,
      status: "failed",
      message: `${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH} 知识候选回收失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readKnowledgeProposalContent(workDir: string, contentPath: string): string {
  const normalized = contentPath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("contentPath must be a relative path inside runtime-output.");
  }
  if (!normalized.startsWith("runtime-output/artifacts/")) {
    throw new Error("contentPath must be under runtime-output/artifacts/.");
  }
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error("contentPath must point to a Markdown .md file.");
  }
  const absolutePath = resolve(workDir, normalized);
  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error("contentPath must point to a Markdown file.");
  }
  if (stats.size > MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES) {
    throw new Error("contentPath exceeds the 256 KB knowledge proposal size limit.");
  }
  const content = readFileSync(absolutePath, "utf8");
  if (containsSensitiveTokenMaterial(content)) {
    throw new Error("contentPath appears to contain credential or token material.");
  }
  return content;
}

function containsSensitiveTokenMaterial(value: string): boolean {
  return [
    /"refresh_token"\s*:/i,
    /"access_token"\s*:/i,
    /"client_secret"\s*:/i,
    /"private_key"\s*:/i,
    /"credentials?"\s*:/i,
    /["']?authorization["']?\s*:\s*["']?(Bearer|Basic)/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  ].some((pattern) => pattern.test(value));
}
