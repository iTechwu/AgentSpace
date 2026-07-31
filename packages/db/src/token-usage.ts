import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { ModelPricingRecord, TokenUsageBillingStatus, TokenUsageRecord } from "./types.ts";

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
  const stmt = db.prepare(
    `INSERT INTO model_pricing (model_id, display_name, input_per_1m, output_per_1m, currency, updated_at)
     VALUES (?, ?, ?, ?, 'USD', ?)
     ON CONFLICT(model_id) DO NOTHING`,
  );
  for (const p of DEFAULT_PRICING) {
    stmt.run(p.modelId, p.displayName, p.inputPer1M, p.outputPer1M, now);
  }
}

/**
 * Persist the current effective tenant price returned by models.dofe.ai.
 * Existing usage keeps the authoritative settled amount in actual_cost_usd;
 * cost_usd is refreshed because it is explicitly the current estimate.
 */
export function upsertModelPricingSync(input: {
  modelId: string;
  displayName?: string;
  inputPer1M: number;
  outputPer1M: number;
  currency?: string;
  updatedAt?: string;
}): ModelPricingRecord {
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error("model_pricing.model_id_required");
  if (![input.inputPer1M, input.outputPer1M].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("model_pricing.invalid_price");
  }

  const db = getDatabase();
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const displayName = input.displayName?.trim() || modelId;
  const currency = input.currency?.trim().toUpperCase() || "USD";
  const existing = db.prepare(
    `SELECT display_name, input_per_1m, output_per_1m, currency
     FROM model_pricing WHERE model_id = ?`,
  ).get(modelId) as {
    display_name: string;
    input_per_1m: number;
    output_per_1m: number;
    currency: string;
  } | undefined;
  db.prepare(
    `INSERT INTO model_pricing (model_id, display_name, input_per_1m, output_per_1m, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (model_id) DO UPDATE SET
       display_name = excluded.display_name,
       input_per_1m = excluded.input_per_1m,
       output_per_1m = excluded.output_per_1m,
       currency = excluded.currency,
       updated_at = excluded.updated_at`,
  ).run(modelId, displayName, input.inputPer1M, input.outputPer1M, currency, updatedAt);

  if (
    !existing
    || existing.input_per_1m !== input.inputPer1M
    || existing.output_per_1m !== input.outputPer1M
    || existing.currency !== currency
  ) {
    db.prepare(
      `UPDATE token_usage
       SET cost_usd = (input_tokens / 1000000.0) * ? + (output_tokens / 1000000.0) * ?,
           currency = CASE WHEN actual_cost_usd IS NULL THEN ? ELSE currency END
       WHERE model_id = ?`,
    ).run(input.inputPer1M, input.outputPer1M, currency, modelId);
  }

  return { modelId, displayName, inputPer1M: input.inputPer1M, outputPer1M: input.outputPer1M, currency, updatedAt };
}

export function listModelPricingSync(): ModelPricingRecord[] {
  const db = getDatabase();
  ensureDefaultPricingSync();
  const rows = db.prepare("SELECT * FROM model_pricing ORDER BY input_per_1m ASC").all() as Array<{
    model_id: string;
    display_name: string;
    input_per_1m: number;
    output_per_1m: number;
    currency: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    modelId: row.model_id,
    displayName: row.display_name,
    inputPer1M: row.input_per_1m,
    outputPer1M: row.output_per_1m,
    currency: row.currency,
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
    currency: string;
    updated_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    modelId: row.model_id,
    displayName: row.display_name,
    inputPer1M: row.input_per_1m,
    outputPer1M: row.output_per_1m,
    currency: row.currency,
    updatedAt: row.updated_at,
  };
}

export function computeCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricingRecord): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

export interface RecordTokenUsageInput {
  taskQueueId?: string;
  agentId: string;
  modelId: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  gatewayRequestId?: string;
  gatewayUsageId?: string;
  protocol?: string;
  actualCostUsd?: number;
  currency?: string;
  billingStatus?: TokenUsageBillingStatus;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  requestStartedAt?: string;
  requestEndedAt?: string;
  sourceUpdatedAt?: string;
  channelName?: string;
  workspaceId?: string;
}

export function recordTokenUsageSync(input: RecordTokenUsageInput): TokenUsageRecord {
  const db = getDatabase();
  const id = randomLikeId();
  const now = new Date().toISOString();
  const pricing = readModelPricingSync(input.modelId);
  const costUsd = pricing ? computeCostUsd(input.inputTokens, input.outputTokens, pricing) : 0;
  const usageCurrency = input.currency?.trim().toUpperCase() || pricing?.currency;
  const workspaceId = input.workspaceId ?? (input.taskQueueId ? readWorkspaceIdForTaskQueueSync(input.taskQueueId) : null) ?? DEFAULT_WORKSPACE_ID;
  const billingStatus = input.billingStatus ?? "estimated";

  const insertResult = db.prepare(
    `INSERT INTO token_usage (
      id, workspace_id, task_queue_id, agent_id, model_id, provider_account_id,
      runtime_credential_id, router_session_id, gateway_request_id, gateway_usage_id,
      protocol, input_tokens, output_tokens, cache_tokens, cost_usd, actual_cost_usd,
      currency, billing_status, request_started_at, request_ended_at, source_updated_at,
      channel_name, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, gateway_request_id)
       WHERE gateway_request_id IS NOT NULL
       DO NOTHING`,
  ).run(
    id,
    workspaceId,
    input.taskQueueId ?? null,
    input.agentId,
    input.modelId,
    input.providerAccountId ?? null,
    input.runtimeCredentialId ?? null,
    input.routerSessionId ?? null,
    input.gatewayRequestId ?? null,
    input.gatewayUsageId ?? null,
    input.protocol ?? null,
    input.inputTokens,
    input.outputTokens,
    input.cacheTokens ?? 0,
    costUsd,
    input.actualCostUsd ?? null,
    usageCurrency ?? null,
    billingStatus,
    input.requestStartedAt ?? null,
    input.requestEndedAt ?? null,
    input.sourceUpdatedAt ?? null,
    input.channelName ?? null,
    now,
  );

  if (insertResult.changes === 0 && input.gatewayRequestId) {
    const existing = findTokenUsageByGatewayRequestIdSync(input.gatewayRequestId, workspaceId);
    if (
      existing?.runtimeCredentialId && input.runtimeCredentialId
      && existing.runtimeCredentialId !== input.runtimeCredentialId
    ) {
      throw new Error("token_usage.gateway_request_runtime_credential_mismatch");
    }
    if (
      existing && input.taskQueueId && !existing.taskQueueId
    ) {
      db.prepare(
        `UPDATE token_usage
         SET task_queue_id = ?,
             agent_id = ?,
             provider_account_id = COALESCE(?, provider_account_id),
             runtime_credential_id = COALESCE(runtime_credential_id, ?),
             router_session_id = COALESCE(?, router_session_id),
             channel_name = COALESCE(?, channel_name),
             billing_status = CASE
               WHEN billing_status = 'unallocated' AND actual_cost_usd IS NOT NULL THEN 'reconciled'
               ELSE billing_status
             END,
             reconciled_at = CASE
               WHEN billing_status = 'unallocated' AND actual_cost_usd IS NOT NULL THEN COALESCE(reconciled_at, ?)
               ELSE reconciled_at
             END
         WHERE id = ? AND task_queue_id IS NULL`,
      ).run(
        input.taskQueueId,
        input.agentId,
        input.providerAccountId ?? null,
        input.runtimeCredentialId ?? null,
        input.routerSessionId ?? null,
        input.channelName ?? null,
        now,
        existing.id,
      );
      return findTokenUsageByGatewayRequestIdSync(input.gatewayRequestId, workspaceId) ?? existing;
    }
    if (existing) return existing;
  }

  return {
    id,
    workspaceId,
    taskQueueId: input.taskQueueId,
    agentId: input.agentId,
    modelId: input.modelId,
    providerAccountId: input.providerAccountId,
    runtimeCredentialId: input.runtimeCredentialId,
    routerSessionId: input.routerSessionId,
    gatewayRequestId: input.gatewayRequestId,
    gatewayUsageId: input.gatewayUsageId,
    protocol: input.protocol,
    actualCostUsd: input.actualCostUsd,
    currency: usageCurrency,
    billingStatus,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheTokens: input.cacheTokens ?? 0,
    costUsd,
    channelName: input.channelName,
    requestStartedAt: input.requestStartedAt,
    requestEndedAt: input.requestEndedAt,
    sourceUpdatedAt: input.sourceUpdatedAt,
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
    runtime_credential_id: string | null;
    router_session_id: string | null;
    gateway_request_id: string | null;
    gateway_usage_id: string | null;
    protocol: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number;
    cost_usd: number;
    actual_cost_usd: number | null;
    currency: string | null;
    billing_status: string | null;
    request_started_at: string | null;
    request_ended_at: string | null;
    source_updated_at: string | null;
    reconciled_at: string | null;
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
    runtimeCredentialId: row.runtime_credential_id ?? undefined,
    routerSessionId: row.router_session_id ?? undefined,
    gatewayRequestId: row.gateway_request_id ?? undefined,
    gatewayUsageId: row.gateway_usage_id ?? undefined,
    protocol: row.protocol ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    costUsd: row.cost_usd,
    actualCostUsd: row.actual_cost_usd ?? undefined,
    currency: row.currency ?? undefined,
    billingStatus: reconcileStatus(row.billing_status),
    requestStartedAt: row.request_started_at ?? undefined,
    requestEndedAt: row.request_ended_at ?? undefined,
    sourceUpdatedAt: row.source_updated_at ?? undefined,
    reconciledAt: row.reconciled_at ?? undefined,
    channelName: row.channel_name ?? undefined,
    createdAt: row.created_at,
  }));
}

function reconcileStatus(value: string | null): TokenUsageRecord["billingStatus"] {
  if (value === "pending_reconciliation" || value === "reconciled" || value === "unallocated") return value;
  return "estimated";
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
            COUNT(DISTINCT task_queue_id) AS task_count
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
  runtimeCredentialId?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
}> {
  const db = getDatabase();
  const params: string[] = [workspaceId];
  // Unmatched remote charges are operational exceptions, not AI employees.
  // They remain visible in billing summaries and recent usage diagnostics.
  let dateFilter = " WHERE workspace_id = ? AND task_queue_id IS NOT NULL";
  if (since) {
    dateFilter += " AND created_at >= ?";
    params.push(since);
  }

  const rows = db.prepare(
    `SELECT agent_id, model_id, provider_account_id, runtime_credential_id,
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COUNT(DISTINCT task_queue_id) AS task_count
     FROM token_usage${dateFilter}
     GROUP BY agent_id, model_id, provider_account_id, runtime_credential_id
     ORDER BY total_cost DESC`,
  ).all(...params) as Array<{
    agent_id: string;
    model_id: string;
    provider_account_id: string | null;
    runtime_credential_id: string | null;
    total_input: number;
    total_output: number;
    total_cost: number;
    task_count: number;
  }>;

  return rows.map((row) => ({
    agentId: row.agent_id,
    modelId: row.model_id,
    providerAccountId: row.provider_account_id ?? undefined,
    runtimeCredentialId: row.runtime_credential_id ?? undefined,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    taskCount: row.task_count,
  }));
}

export function getRuntimeCostSummarySync(
  runtimeId: string,
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
} {
  const db = getDatabase();
  const params: string[] = [workspaceId, runtimeId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND t.created_at >= ?";
    params.push(since);
  }

  const row = db.prepare(
    `SELECT COALESCE(SUM(t.input_tokens), 0) AS total_input,
            COALESCE(SUM(t.output_tokens), 0) AS total_output,
            COALESCE(SUM(t.cost_usd), 0) AS total_cost,
            COALESCE(SUM(t.actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT t.task_queue_id) AS task_count
     FROM token_usage t
     JOIN agent_task_queue q ON q.id = t.task_queue_id AND q.workspace_id = t.workspace_id
     WHERE t.workspace_id = ? AND q.runtime_id = ?${dateFilter}`,
  ).get(...params) as {
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  };
}

export function listRuntimeCostSummariesSync(
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Array<{
  runtimeId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
}> {
  const db = getDatabase();
  const params: string[] = [workspaceId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND t.created_at >= ?";
    params.push(since);
  }

  const rows = db.prepare(
    `SELECT q.runtime_id,
            COALESCE(SUM(t.input_tokens), 0) AS total_input,
            COALESCE(SUM(t.output_tokens), 0) AS total_output,
            COALESCE(SUM(t.cost_usd), 0) AS total_cost,
            COALESCE(SUM(t.actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT t.task_queue_id) AS task_count
     FROM token_usage t
     JOIN agent_task_queue q ON q.id = t.task_queue_id AND q.workspace_id = t.workspace_id
     WHERE t.workspace_id = ?${dateFilter}
     GROUP BY q.runtime_id
     ORDER BY total_cost DESC`,
  ).all(...params) as Array<{
    runtime_id: string;
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  }>;

  return rows.map((row) => ({
    runtimeId: row.runtime_id,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  }));
}

export function getRuntimeCredentialCostSummarySync(
  runtimeCredentialId: string,
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
} {
  const db = getDatabase();
  const params: string[] = [workspaceId, runtimeCredentialId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND created_at >= ?";
    params.push(since);
  }

  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(SUM(actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT task_queue_id) AS task_count
     FROM token_usage
     WHERE workspace_id = ? AND runtime_credential_id = ?${dateFilter}`,
  ).get(...params) as {
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  };
}

export function listRuntimeCredentialCostSummariesSync(
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Array<{
  runtimeCredentialId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
}> {
  const db = getDatabase();
  const params: string[] = [workspaceId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND created_at >= ?";
    params.push(since);
  }

  const rows = db.prepare(
    `SELECT runtime_credential_id,
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(SUM(actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT task_queue_id) AS task_count
     FROM token_usage
     WHERE workspace_id = ? AND runtime_credential_id IS NOT NULL${dateFilter}
     GROUP BY runtime_credential_id
     ORDER BY total_cost DESC`,
  ).all(...params) as Array<{
    runtime_credential_id: string;
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  }>;

  return rows.map((row) => ({
    runtimeCredentialId: row.runtime_credential_id,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  }));
}

export function getSessionCostSummarySync(
  routerSessionId: string,
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
} {
  const db = getDatabase();
  const params: string[] = [workspaceId, routerSessionId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND created_at >= ?";
    params.push(since);
  }

  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(SUM(actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT task_queue_id) AS task_count
     FROM token_usage
     WHERE workspace_id = ? AND router_session_id = ?${dateFilter}`,
  ).get(...params) as {
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  };
}

export function listSessionCostSummariesSync(
  since?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Array<{
  routerSessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
}> {
  const db = getDatabase();
  const params: string[] = [workspaceId];
  let dateFilter = "";
  if (since) {
    dateFilter = " AND created_at >= ?";
    params.push(since);
  }

  const rows = db.prepare(
    `SELECT router_session_id,
            COALESCE(SUM(input_tokens), 0) AS total_input,
            COALESCE(SUM(output_tokens), 0) AS total_output,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(SUM(actual_cost_usd), 0) AS total_actual,
            COUNT(DISTINCT task_queue_id) AS task_count
     FROM token_usage
     WHERE workspace_id = ? AND router_session_id IS NOT NULL${dateFilter}
     GROUP BY router_session_id
     ORDER BY total_cost DESC`,
  ).all(...params) as Array<{
    router_session_id: string;
    total_input: number;
    total_output: number;
    total_cost: number;
    total_actual: number;
    task_count: number;
  }>;

  return rows.map((row) => ({
    routerSessionId: row.router_session_id,
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCostUsd: row.total_cost,
    totalActualCostUsd: row.total_actual,
    taskCount: row.task_count,
  }));
}

export function findTokenUsageByGatewayRequestIdSync(
  gatewayRequestId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): TokenUsageRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT * FROM token_usage WHERE workspace_id = ? AND gateway_request_id = ?`,
  ).get(workspaceId, gatewayRequestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapTokenUsageRow(row);
}

export function findTokenUsageByGatewayUsageIdSync(
  gatewayUsageId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): TokenUsageRecord | null {
  const row = getDatabase().prepare(
    `SELECT * FROM token_usage WHERE workspace_id = ? AND gateway_usage_id = ?`,
  ).get(workspaceId, gatewayUsageId) as Record<string, unknown> | undefined;
  return row ? mapTokenUsageRow(row) : null;
}

export function markTokenUsageReconciledSync(
  id: string,
  input: {
    actualCostUsd: number;
    currency: string;
    gatewayRequestId?: string;
    gatewayUsageId?: string;
    protocol?: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens?: number;
    requestStartedAt?: string;
    requestEndedAt?: string;
    sourceUpdatedAt?: string;
    billingStatus?: "pending_reconciliation" | "reconciled" | "unallocated";
  },
): TokenUsageRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const pricing = readModelPricingSync(input.modelId);
  const costUsd = pricing ? computeCostUsd(input.inputTokens, input.outputTokens, pricing) : 0;
  db.prepare(
    `UPDATE token_usage
     SET billing_status = ?,
         actual_cost_usd = ?,
         currency = ?,
         gateway_request_id = COALESCE(gateway_request_id, ?),
         gateway_usage_id = COALESCE(?, gateway_usage_id),
         protocol = COALESCE(?, protocol),
         model_id = ?,
         input_tokens = ?,
         output_tokens = ?,
         cache_tokens = ?,
         cost_usd = ?,
         request_started_at = COALESCE(?, request_started_at),
         request_ended_at = COALESCE(?, request_ended_at),
         source_updated_at = COALESCE(?, source_updated_at),
         reconciled_at = ?
     WHERE id = ?`,
  ).run(
    input.billingStatus ?? "reconciled",
    input.actualCostUsd,
    input.currency,
    input.gatewayRequestId ?? null,
    input.gatewayUsageId ?? null,
    input.protocol ?? null,
    input.modelId,
    input.inputTokens,
    input.outputTokens,
    input.cacheTokens ?? 0,
    costUsd,
    input.requestStartedAt ?? null,
    input.requestEndedAt ?? null,
    input.sourceUpdatedAt ?? null,
    input.billingStatus === "pending_reconciliation" ? null : now,
    id,
  );
  const row = db.prepare("SELECT * FROM token_usage WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapTokenUsageRow(row) : null;
}

interface InsertUnallocatedTokenUsageInput {
  workspaceId: string;
  agentId: string;
  modelId: string;
  runtimeCredentialId: string;
  gatewayRequestId: string;
  gatewayUsageId?: string;
  protocol?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  actualCostUsd: number;
  currency: string;
  channelName?: string;
  createdAt?: string;
  requestStartedAt?: string;
  requestEndedAt?: string;
  sourceUpdatedAt?: string;
  billingStatus?: "pending_reconciliation" | "unallocated";
}

export function insertUnallocatedTokenUsageIfAbsentSync(
  input: InsertUnallocatedTokenUsageInput,
): { record: TokenUsageRecord; inserted: boolean } {
  const db = getDatabase();
  const id = randomLikeId();
  const now = input.createdAt ?? new Date().toISOString();
  const insertResult = db.prepare(
    `INSERT INTO token_usage (
      id, workspace_id, task_queue_id, agent_id, model_id,
      runtime_credential_id, gateway_request_id, gateway_usage_id, protocol,
      input_tokens, output_tokens, cache_tokens, cost_usd, actual_cost_usd, currency,
      billing_status, request_started_at, request_ended_at, source_updated_at, channel_name, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, gateway_request_id)
       WHERE gateway_request_id IS NOT NULL
       DO NOTHING`,
  ).run(
    id,
    input.workspaceId,
    input.agentId,
    input.modelId,
    input.runtimeCredentialId,
    input.gatewayRequestId,
    input.gatewayUsageId ?? null,
    input.protocol ?? null,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.cacheTokens ?? 0,
    input.actualCostUsd,
    input.currency,
    input.billingStatus ?? "unallocated",
    input.requestStartedAt ?? null,
    input.requestEndedAt ?? null,
    input.sourceUpdatedAt ?? null,
    input.channelName ?? null,
    now,
  );
  const row = insertResult.changes > 0
    ? db.prepare("SELECT * FROM token_usage WHERE id = ?").get(id) as Record<string, unknown>
    : db.prepare("SELECT * FROM token_usage WHERE workspace_id = ? AND gateway_request_id = ?")
        .get(input.workspaceId, input.gatewayRequestId) as Record<string, unknown>;
  const record = mapTokenUsageRow(row);
  if (
    !insertResult.changes && record.runtimeCredentialId
    && record.runtimeCredentialId !== input.runtimeCredentialId
  ) {
    throw new Error("token_usage.gateway_request_runtime_credential_mismatch");
  }
  return { record, inserted: insertResult.changes > 0 };
}

export function insertUnallocatedTokenUsageSync(input: InsertUnallocatedTokenUsageInput): TokenUsageRecord {
  return insertUnallocatedTokenUsageIfAbsentSync(input).record;
}

function mapTokenUsageRow(row: Record<string, unknown>): TokenUsageRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    taskQueueId: typeof row.task_queue_id === "string" ? row.task_queue_id : undefined,
    agentId: String(row.agent_id),
    modelId: String(row.model_id),
    providerAccountId: typeof row.provider_account_id === "string" ? row.provider_account_id : undefined,
    runtimeCredentialId: typeof row.runtime_credential_id === "string" ? row.runtime_credential_id : undefined,
    routerSessionId: typeof row.router_session_id === "string" ? row.router_session_id : undefined,
    gatewayRequestId: typeof row.gateway_request_id === "string" ? row.gateway_request_id : undefined,
    gatewayUsageId: typeof row.gateway_usage_id === "string" ? row.gateway_usage_id : undefined,
    protocol: typeof row.protocol === "string" ? row.protocol : undefined,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    cacheTokens: Number(row.cache_tokens) || 0,
    costUsd: Number(row.cost_usd) || 0,
    actualCostUsd: typeof row.actual_cost_usd === "number" ? row.actual_cost_usd : undefined,
    currency: typeof row.currency === "string" ? row.currency : undefined,
    billingStatus: reconcileStatus(String(row.billing_status)),
    requestStartedAt: typeof row.request_started_at === "string" ? row.request_started_at : undefined,
    requestEndedAt: typeof row.request_ended_at === "string" ? row.request_ended_at : undefined,
    sourceUpdatedAt: typeof row.source_updated_at === "string" ? row.source_updated_at : undefined,
    reconciledAt: typeof row.reconciled_at === "string" ? row.reconciled_at : undefined,
    channelName: typeof row.channel_name === "string" ? row.channel_name : undefined,
    createdAt: String(row.created_at),
  };
}

function readWorkspaceIdForTaskQueueSync(taskQueueId: string): string | null {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT workspace_id AS workspaceId FROM agent_task_queue WHERE id = ?",
  ).get(taskQueueId) as { workspaceId?: string } | undefined;

  return typeof row?.workspaceId === "string" ? row.workspaceId : null;
}
