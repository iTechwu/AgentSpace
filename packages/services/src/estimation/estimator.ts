import { DEFAULT_WORKSPACE_ID, listTokenUsageSync, readModelPricingSync, computeCostUsd } from "@dofe-agent/db";
import type { TokenUsageRecord } from "@dofe-agent/db";
import type { ActiveEmployee, TaskRecord } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";

export interface EstimationInput {
  taskTitle: string;
  taskDescription?: string;
  channelName?: string;
  candidateAgentIds?: string[];
}

export interface AgentEstimation {
  agentId: string;
  displayName: string;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  confidence: "high" | "medium" | "low";
  basedOnTaskCount: number;
  avgCompletionRate: number;
  recommendedBudgetUsd: number;
  recommended: boolean;
}

export interface TaskEstimationResult {
  taskTitle: string;
  channelName: string;
  agents: AgentEstimation[];
}

const COLD_START_RULES = {
  short: { inputTokens: 2000, outputTokens: 1000 },
  medium: { inputTokens: 5000, outputTokens: 3000 },
  long: { inputTokens: 12000, outputTokens: 8000 },
};

const CODE_KEYWORDS = ["代码", "code", "implement", "bug", "fix", "refactor", "function", "api", "实现", "修复"];
const RESEARCH_KEYWORDS = ["research", "分析", "调研", "报告", "report", "analyze", "review", "评估"];

const BUDGET_BUFFER = 1.5;

export function estimateTaskSync(input: EstimationInput, workspaceId = DEFAULT_WORKSPACE_ID): TaskEstimationResult {
  const state = ensureWorkspaceStateSync(workspaceId);
  const channelName = input.channelName ?? "";
  const taskText = `${input.taskTitle} ${input.taskDescription ?? ""}`.trim();

  const candidateIds: string[] = input.candidateAgentIds && input.candidateAgentIds.length > 0
    ? input.candidateAgentIds
    : state.activeEmployees.map((e: ActiveEmployee) => e.name);

  const agents: AgentEstimation[] = candidateIds.map((agentId: string) => {
    const employee = state.activeEmployees.find((e: ActiveEmployee) => sameValue(e.name, agentId));
    const displayName = employee?.remarkName?.trim() || agentId;

    const historyRecords = listTokenUsageSync({
      workspaceId,
      agentId,
      channelName: channelName || undefined,
    });

    if (historyRecords.length >= 3) {
      return buildHistoryEstimation(agentId, displayName, historyRecords, state);
    }

    const allRecords = listTokenUsageSync({ workspaceId, agentId });
    if (allRecords.length >= 3) {
      return buildHistoryEstimation(agentId, displayName, allRecords, state);
    }

    return buildColdStartEstimation(agentId, displayName, taskText, state);
  });

  agents.sort((a, b) => {
    const scoreA = estimationScore(a);
    const scoreB = estimationScore(b);
    return scoreB - scoreA;
  });

  if (agents.length > 0) {
    agents[0]!.recommended = true;
  }

  return {
    taskTitle: input.taskTitle,
    channelName,
    agents,
  };
}

function buildHistoryEstimation(
  agentId: string,
  displayName: string,
  records: TokenUsageRecord[],
  state: ReturnType<typeof ensureWorkspaceStateSync>,
): AgentEstimation {
  const avgInput = Math.round(records.reduce((s, r) => s + r.inputTokens, 0) / records.length);
  const avgOutput = Math.round(records.reduce((s, r) => s + r.outputTokens, 0) / records.length);
  const primaryModelId = mostCommonModel(records);
  const pricing = readModelPricingSync(primaryModelId);
  const costUsd = pricing
    ? computeCostUsd(avgInput, avgOutput, pricing)
    : records.reduce((s, r) => s + r.costUsd, 0) / records.length;
  const confidence = records.length >= 10 ? "high" : "medium";

  const tasks: TaskRecord[] = state.tasks.filter((task: TaskRecord) => sameValue(task.assignee, agentId));
  const completed = tasks.filter((task: TaskRecord) => task.status === "done").length;
  const total = tasks.length;

  return {
    agentId,
    displayName,
    modelId: primaryModelId,
    estimatedInputTokens: avgInput,
    estimatedOutputTokens: avgOutput,
    estimatedCostUsd: costUsd,
    confidence,
    basedOnTaskCount: records.length,
    avgCompletionRate: total > 0 ? completed / total : 0,
    recommendedBudgetUsd: costUsd * BUDGET_BUFFER,
    recommended: false,
  };
}

function buildColdStartEstimation(
  agentId: string,
  displayName: string,
  taskText: string,
  state: ReturnType<typeof ensureWorkspaceStateSync>,
): AgentEstimation {
  const length = taskText.length;
  const base = length < 50
    ? COLD_START_RULES.short
    : length <= 200
      ? COLD_START_RULES.medium
      : COLD_START_RULES.long;

  const lowerText = taskText.toLocaleLowerCase("zh-CN");
  let multiplier = 1.0;
  if (CODE_KEYWORDS.some((kw) => lowerText.includes(kw))) {
    multiplier = 2.0;
  } else if (RESEARCH_KEYWORDS.some((kw) => lowerText.includes(kw))) {
    multiplier = 1.5;
  }

  const inputTokens = Math.round(base.inputTokens * multiplier);
  const outputTokens = Math.round(base.outputTokens * multiplier);
  const modelId = "claude-haiku-4-5-20251001";
  const pricing = readModelPricingSync(modelId);
  const costUsd = pricing
    ? computeCostUsd(inputTokens, outputTokens, pricing)
    : 0;

  const tasks: TaskRecord[] = state.tasks.filter((task: TaskRecord) => sameValue(task.assignee, agentId));
  const completed = tasks.filter((task: TaskRecord) => task.status === "done").length;
  const total = tasks.length;

  return {
    agentId,
    displayName,
    modelId,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: costUsd,
    confidence: "low",
    basedOnTaskCount: 0,
    avgCompletionRate: total > 0 ? completed / total : 0,
    recommendedBudgetUsd: costUsd * BUDGET_BUFFER,
    recommended: false,
  };
}

function mostCommonModel(records: TokenUsageRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) {
    counts.set(r.modelId, (counts.get(r.modelId) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [modelId, count] of counts) {
    if (count > bestCount) {
      best = modelId;
      bestCount = count;
    }
  }
  return best || "unknown";
}

function estimationScore(estimation: AgentEstimation): number {
  const confidenceWeight = estimation.confidence === "high" ? 3 : estimation.confidence === "medium" ? 2 : 1;
  const completionWeight = estimation.avgCompletionRate * 2;
  const costPenalty = estimation.estimatedCostUsd > 0 ? 1 / (1 + estimation.estimatedCostUsd) : 0.5;
  return confidenceWeight + completionWeight + costPenalty;
}
