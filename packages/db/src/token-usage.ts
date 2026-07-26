import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { ModelPricingRecord, TokenUsageRecord } from "./types.ts";

const DEFAULT_PRICING: Array<{ modelId: string; displayName: string; inputPer1M: number; outputPer1M: number }> = [
  { modelId: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", inputPer1M: 0.80, outputPer1M: 4.00 },
  { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", inputPer1M: 3.00, outputPer1M: 15.00 },
  { modelId: "claude-opus-4-6", displayName: "Claude Opus 4.6", inputPer1M: 15.00, outputPer1M: 75.00 },
  { modelId: "gpt-4o", displayName: "GPT-4o", inputPer1M: 2.50, outputPer1M: 10.00 },
  { modelId: "gpt-4o-mini", displayName: "GPT-4o Mini", inputPer1M: 0.15, outputPer1M: 0.60 },
  { modelId: "o3", displayName: "o3", inputPer1M: 2.00, outputPer1M: 8.00 },
  { modelId: "codex-mini", displayName: "Codex Mini", inputPer1M: 1.50, outputPer1M: 6.00 },
  { modelId: "gemini-2.0-flash-lite", displayName: "Gemini 2.0 Flash Lite", inputPer1M: 0.075, outputPer1M: 0.30 },
  { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputPer1M: 1.25, outputPer1M: 10.00 },
  { modelId: "opencode-default", displayName: "OpenCode Default (configure pricing)", inputPer1M: 0, outputPer1M: 0 },
  { modelId: "nanobot-default", displayName: "NanoBot Default (configure pricing)", inputPer1M: 0, outputPer1M: 0 },
];

export function ensureDefaultPricingSync(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM model_pricing").get() as { count: number };
  if (existing.count > 0) return;

  const stmt = db.prepare(
    `INSERT INTO model_pricing (model_id, display_name, input_per_1m, output_per_1m, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(model_id) DO NOTHING`,
  );
  for (const p of DEFAULT_PRICING) {
    stmt.run(p.modelId, p.displayName, p.inputPer1M, p.outputPer1M, now);
  }
}

export function listModelPricingSync(): ModelPricingRecord[] {
  const db = getDatabase();
  ensureDefaultPricingSync();
  const rows = db.prepare("SELECT * FROM model_pricing ORDER BY input_per_1m ASC").all() as Array<{
    model_id: string;
    display_name: string;
    input_per_1m: number;
    output_per_1m: number;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    modelId: row.model_id,
    displayName: row.display_name,
    inputPer1M: row.input_per_1m,
    outputPer1M: row.output_per_1m,
    updatedAt: row.updated_at,
  }));
}

export function readModelPricingSync(modelId: string): ModelPricingRecord | undefined {
  const db = getDatabase();
  ensureDefaultPricingSync();
  const row = db.prepare("SELECT * FROM model_pricing WHERE model_id = ?").get(modelId) as {
    model_id: string;
    display_name: string;
    input_per_1m: number;
    output_per_1m: number;
    updated_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    modelId: row.model_id,
    displayName: row.display_name,
    inputPer1M: row.input_per_1m,
    outputPer1M: row.output_per_1m,
    updatedAt: row.updated_at,
  };
}

export function computeCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricingRecord): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

export function recordTokenUsageSync(input: {
  taskQueueId: string;
  agentId: string;
  modelId: string;
  providerAccountId?: string;
  inputTokens: number;
  outputTokens: number;
  channelName?: string;
  workspaceId?: string;
}): TokenUsageRecord {
  const db = getDatabase();
  const id = randomLikeId();
  const now = new Date().toISOString();
  const pricing = readModelPricingSync(input.modelId);
  const costUsd = pricing ? computeCostUsd(input.inputTokens, input.outputTokens, pricing) : 0;
  const workspaceId = input.workspaceId ?? readWorkspaceIdForTaskQueueSync(input.taskQueueId) ?? DEFAULT_WORKSPACE_ID;

  db.prepare(
    `INSERT INTO token_usage (id, workspace_id, task_queue_id, agent_id, model_id, provider_account_id, input_tokens, output_tokens, cost_usd, channel_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, input.taskQueueId, input.agentId, input.modelId, input.providerAccountId ?? null, input.inputTokens, input.outputTokens, costUsd, input.channelName ?? null, now);

  return {
    id,
    workspaceId,
    taskQueueId: input.taskQueueId,
    agentId: input.agentId,
    modelId: input.modelId,
    providerAccountId: input.providerAccountId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd,
    channelName: input.channelName,
    createdAt: now,
  };
}

export function listTokenUsageSync(filters?: {
  workspaceId?: string;
  agentId?: string;
  channelName?: string;
  providerAccountId?: string;
  since?: string;
}): TokenUsageRecord[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: string[] = [];

  conditions.push("workspace_id = ?");
  params.push(filters?.workspaceId ?? DEFAULT_WORKSPACE_ID);

  if (filters?.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  if (filters?.channelName) {
    conditions.push("channel_name = ?");
    params.push(filters.channelName);
  }
  if (filters?.providerAccountId) {
    conditions.push("provider_account_id = ?");
    params.push(filters.providerAccountId);
  }
  if (filters?.since) {
    conditions.push("created_at >= ?");
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM token_usage ${where} ORDER BY created_at DESC`).all(...params) as Array<{
    id: string;
    workspace_id: string;
    task_queue_id: string;
    agent_id: string;
    model_id: string;
    provider_account_id: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    channel_name: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    taskQueueId: row.task_queue_id,
    agentId: row.agent_id,
    modelId: row.model_id,
    providerAccountId: row.provider_account_id ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    channelName: row.channel_name ?? undefined,
    createdAt: row.created_at,
  }));
}

export function getAgentCostSummarySync(agentId: string, since?: string, workspaceId = DEFAULT_WORKSPACE_ID): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
} {
  const db = getDatabase();
  const params: string[] = [workspaceId, agentId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND created_at >= ?";
    params.push(since);
  }

  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COUNT(*) AS task_count
     FROM token_usage WHERE workspace_id = ? AND agent_id = ?${dateFilter}`,
  ).get(...params) as { total_input: number; total_output: number; total_cost: number; task_count: number };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    taskCount: row.task_count,
  };
}

export function getWorkspaceCostSummarySync(since?: string, workspaceId = DEFAULT_WORKSPACE_ID): Array<{
  agentId: string;
  modelId: string;
  providerAccountId?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
}> {
  const db = getDatabase();
  const params: string[] = [workspaceId];
  let dateFilter = " WHERE workspace_id = ?";
  if (since) {
    dateFilter += " AND created_at >= ?";
    params.push(since);
  }

  const rows = db.prepare(
    `SELECT agent_id, model_id, provider_account_id,
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COUNT(*) AS task_count
     FROM token_usage${dateFilter}
     GROUP BY agent_id, model_id, provider_account_id
     ORDER BY total_cost DESC`,
  ).all(...params) as Array<{
    agent_id: string;
    model_id: string;
    provider_account_id: string | null;
    total_input: number;
    total_output: number;
    total_cost: number;
    task_count: number;
  }>;

  return rows.map((row) => ({
    agentId: row.agent_id,
    modelId: row.model_id,
    providerAccountId: row.provider_account_id ?? undefined,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    taskCount: row.task_count,
  }));
}

function readWorkspaceIdForTaskQueueSync(taskQueueId: string): string | null {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT workspace_id AS workspaceId FROM agent_task_queue WHERE id = ?",
  ).get(taskQueueId) as { workspaceId?: string } | undefined;

  return typeof row?.workspaceId === "string" ? row.workspaceId : null;
}
