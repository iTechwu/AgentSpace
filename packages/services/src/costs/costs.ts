import {
  DEFAULT_WORKSPACE_ID,
  listTokenUsageSync,
  getAgentCostSummarySync,
  getWorkspaceCostSummarySync,
  getWorkspaceBillingSummarySync,
  getMonthStartIso,
  getRuntimeCostSummarySync,
  listRuntimeCostSummariesSync,
  getRuntimeCredentialCostSummarySync,
  listRuntimeCredentialCostSummariesSync,
  getSessionCostSummarySync,
  listSessionCostSummariesSync,
  listWorkspaceRuntimeDisplayNamesSync,
  readWorkspaceSsoBindingSync,
} from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync } from "../shared/state-io.ts";
import {
  getModelsTenantBillingReportAsync,
  isModelsInternalConfigured,
  type ModelsBillingDimensionAggregate,
  type ModelsTenantBillingReport,
} from "../models/client.ts";

export interface AgentCostProfile {
  agentId: string;
  displayName: string;
  modelId: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
  currency?: string;
}

export interface CostDashboardData {
  agents: AgentCostProfile[];
  runtimes: RuntimeCostProfile[];
  runtimeCredentials: RuntimeCredentialCostProfile[];
  sessions: SessionCostProfile[];
  totalCostUsd: number;
  totalTasks: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  pendingReconciliationCostUsd: number;
  reconciledCostUsd: number;
  unallocatedCostUsd: number;
  totalActualCostUsd: number;
  billingByCurrency: Array<{
    currency: string;
    estimatedCost: number;
    pendingReconciliationCost: number;
    reconciledCost: number;
    unallocatedCost: number;
    totalActualCost: number;
  }>;
  lastReconciledAt?: string;
  billingReportState?: "authoritative" | "unavailable" | "not_configured" | "tenant_scope_missing";
  reportCurrency?: string;
  modelCount?: number;
  models: Array<{ modelId: string; displayName: string; inputPer1M: number; outputPer1M: number }>;
  recentUsage: Array<{
    id: string;
    agentId: string;
    displayName: string;
    modelId: string;
    providerAccountId?: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    actualCostUsd?: number;
    billingStatus: string;
    currency?: string;
    protocol?: string;
    gatewayRequestId?: string;
    gatewayUsageId?: string;
    reconciledAt?: string;
    sourceUpdatedAt?: string;
    requestStartedAt?: string;
    requestEndedAt?: string;
    channelName?: string;
    createdAt: string;
  }>;
}

export function getCostDashboardDataSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): CostDashboardData {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const state = readWorkspaceStateSync(workspaceId);
  const employeeIndex = new Map<string, string>(
    state.activeEmployees.map((e: ActiveEmployee) => [e.name, e.remarkName?.trim() ?? e.name]),
  );

  const summaries = getWorkspaceCostSummarySync(since, workspaceId);
  const recentUsage = listTokenUsageSync({ since, workspaceId }).slice(0, 50);
  const billing = getWorkspaceBillingSummarySync(since, workspaceId);
  const runtimes = listRuntimeCostProfilesSync(period, workspaceId);
  const runtimeCredentials = listRuntimeCredentialCostProfilesSync(period, workspaceId);
  const sessions = listSessionCostProfilesSync(period, workspaceId);

  const agents: AgentCostProfile[] = summaries.map((s: (typeof summaries)[number]) => ({
    agentId: s.agentId,
    displayName: employeeIndex.get(s.agentId) ?? s.agentId,
    modelId: s.modelId,
    providerAccountId: s.providerAccountId,
    runtimeCredentialId: s.runtimeCredentialId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));

  return {
    agents,
    runtimes,
    runtimeCredentials,
    sessions,
    totalCostUsd: agents.reduce((sum, a) => sum + a.totalCostUsd, 0),
    totalTasks: agents.reduce((sum, a) => sum + a.taskCount, 0),
    totalInputTokens: agents.reduce((sum, a) => sum + a.totalInputTokens, 0),
    totalOutputTokens: agents.reduce((sum, a) => sum + a.totalOutputTokens, 0),
    estimatedCostUsd: billing.estimatedCostUsd,
    pendingReconciliationCostUsd: billing.pendingReconciliationCostUsd,
    reconciledCostUsd: billing.reconciledCostUsd,
    unallocatedCostUsd: billing.unallocatedCostUsd,
    totalActualCostUsd: billing.totalActualCostUsd,
    billingByCurrency: billing.billingByCurrency,
    lastReconciledAt: billing.lastReconciledAt,
    models: [...new Set(summaries.map((summary) => summary.modelId))].map((modelId) => ({
      modelId,
      displayName: modelId,
      inputPer1M: 0,
      outputPer1M: 0,
    })),
    recentUsage: recentUsage.map((u: (typeof recentUsage)[number]) => ({
      id: u.id,
      agentId: u.agentId,
      displayName: employeeIndex.get(u.agentId) ?? u.agentId,
      modelId: u.modelId,
      providerAccountId: u.providerAccountId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheTokens: u.cacheTokens,
      costUsd: u.costUsd,
      actualCostUsd: u.actualCostUsd,
      billingStatus: u.billingStatus ?? "estimated",
      currency: u.currency,
      protocol: u.protocol,
      gatewayRequestId: u.gatewayRequestId,
      gatewayUsageId: u.gatewayUsageId,
      reconciledAt: u.reconciledAt,
      sourceUpdatedAt: u.sourceUpdatedAt,
      requestStartedAt: u.requestStartedAt,
      requestEndedAt: u.requestEndedAt,
      channelName: u.channelName,
      createdAt: u.createdAt,
    })),
  };
}

export async function getCostDashboardDataAsync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<CostDashboardData> {
  const local = getCostDashboardDataSync(period, workspaceId);
  if (!isModelsInternalConfigured()) {
    return withoutLocalMoney(local, "not_configured");
  }
  const binding = readWorkspaceSsoBindingSync(workspaceId);
  if (!binding?.tenantId) {
    return withoutLocalMoney(local, "tenant_scope_missing");
  }

  try {
    const report = await getModelsTenantBillingReportAsync({
      tenantId: binding.tenantId,
      ssoTeamId: binding.teamId,
      startDate: period === "monthly" ? getMonthStartIso() : undefined,
      endDate: new Date().toISOString(),
    });
    return applyAuthoritativeBillingReport(local, report, workspaceId);
  } catch {
    return withoutLocalMoney(local, "unavailable");
  }
}

function withoutLocalMoney(
  data: CostDashboardData,
  state: Exclude<NonNullable<CostDashboardData["billingReportState"]>, "authoritative">,
): CostDashboardData {
  return {
    ...data,
    agents: data.agents.map((item) => ({ ...item, totalCostUsd: 0, avgCostPerTask: 0 })),
    runtimes: data.runtimes.map((item) => ({ ...item, totalCostUsd: 0, totalActualCostUsd: 0, avgCostPerTask: 0 })),
    runtimeCredentials: data.runtimeCredentials.map((item) => ({ ...item, totalCostUsd: 0, totalActualCostUsd: 0, avgCostPerTask: 0 })),
    sessions: data.sessions.map((item) => ({ ...item, totalCostUsd: 0, totalActualCostUsd: 0, avgCostPerTask: 0 })),
    totalCostUsd: 0,
    estimatedCostUsd: 0,
    pendingReconciliationCostUsd: 0,
    reconciledCostUsd: 0,
    unallocatedCostUsd: 0,
    totalActualCostUsd: 0,
    billingByCurrency: [],
    billingReportState: state,
  };
}

interface DimensionAmount {
  id: string | null;
  currency: string;
  inputTokens: number;
  outputTokens: number;
  charge: number;
  settledCharge: number;
}

function aggregateDimensions(rows: ModelsBillingDimensionAggregate[]): DimensionAmount[] {
  const grouped = new Map<string, DimensionAmount>();
  for (const row of rows) {
    const key = `${row.id ?? "__unattributed__"}:${row.currency}`;
    const current = grouped.get(key) ?? {
      id: row.id,
      currency: row.currency,
      inputTokens: 0,
      outputTokens: 0,
      charge: 0,
      settledCharge: 0,
    };
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    const charge = row.billingStatus === "released" ? 0 : Number(row.tenantCharge);
    current.charge += charge;
    if (row.billingStatus === "settled") current.settledCharge += charge;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function applyAuthoritativeBillingReport(
  local: CostDashboardData,
  report: ModelsTenantBillingReport,
  workspaceId: string,
): CostDashboardData {
  const currencies = new Map<string, CostDashboardData["billingByCurrency"][number]>();
  for (const row of report.totals) {
    const current = currencies.get(row.currency) ?? {
      currency: row.currency,
      estimatedCost: 0,
      pendingReconciliationCost: 0,
      reconciledCost: 0,
      unallocatedCost: 0,
      totalActualCost: 0,
    };
    const charge = row.billingStatus === "released" ? 0 : Number(row.tenantCharge);
    current.estimatedCost += charge;
    if (row.billingStatus === "created" || row.billingStatus === "reserved") {
      current.pendingReconciliationCost += charge;
    } else if (row.billingStatus === "settled") {
      current.reconciledCost += charge;
      current.totalActualCost += charge;
    } else if (row.billingStatus === "reconciliation_required" || row.billingStatus === "untracked") {
      current.unallocatedCost += charge;
    }
    currencies.set(row.currency, current);
  }
  const billingByCurrency = [...currencies.values()];
  const singleCurrency = billingByCurrency.length === 1 ? billingByCurrency[0] : undefined;
  const localAgents = new Map(local.agents.map((item) => [item.agentId, item]));
  const localRuntimes = new Map(local.runtimes.map((item) => [item.runtimeId, item]));
  const localCredentials = new Map(local.runtimeCredentials.map((item) => [item.runtimeCredentialId, item]));
  const localSessions = new Map(local.sessions.map((item) => [item.routerSessionId, item]));
  const employeeNames = new Map(
    readWorkspaceStateSync(workspaceId).activeEmployees.map((employee) => [
      employee.name,
      employee.remarkName?.trim() || employee.name,
    ]),
  );

  const agents = aggregateDimensions(report.breakdowns.employees).map((item) => {
    const localAgent = item.id ? localAgents.get(item.id) : undefined;
    const taskCount = localAgent?.taskCount ?? 0;
    return {
      agentId: item.id ?? "__unattributed__",
      displayName: item.id ? employeeNames.get(item.id) ?? item.id : "未归属用量",
      modelId: localAgent?.modelId ?? "多模型",
      providerAccountId: `models:${item.currency}`,
      totalInputTokens: item.inputTokens,
      totalOutputTokens: item.outputTokens,
      totalCostUsd: item.charge,
      taskCount,
      avgCostPerTask: taskCount > 0 ? item.charge / taskCount : 0,
      currency: item.currency,
    } satisfies AgentCostProfile;
  });

  const runtimes = aggregateDimensions(report.breakdowns.runtimes).map((item) => {
    const previous = item.id ? localRuntimes.get(item.id) : undefined;
    const taskCount = previous?.taskCount ?? 0;
    return {
      runtimeId: item.id ?? "__unattributed__",
      displayName: item.id ? previous?.displayName : "未归属 Runtime",
      totalInputTokens: item.inputTokens,
      totalOutputTokens: item.outputTokens,
      totalCostUsd: item.charge,
      totalActualCostUsd: item.settledCharge,
      taskCount,
      avgCostPerTask: taskCount > 0 ? item.charge / taskCount : 0,
      currency: item.currency,
    } satisfies RuntimeCostProfile;
  });
  const runtimeCredentials = aggregateDimensions(report.breakdowns.runtimeCredentials).map((item) => {
    const previous = item.id ? localCredentials.get(item.id) : undefined;
    const taskCount = previous?.taskCount ?? 0;
    return {
      runtimeCredentialId: item.id ?? "__unattributed__",
      totalInputTokens: item.inputTokens,
      totalOutputTokens: item.outputTokens,
      totalCostUsd: item.charge,
      totalActualCostUsd: item.settledCharge,
      taskCount,
      avgCostPerTask: taskCount > 0 ? item.charge / taskCount : 0,
      currency: item.currency,
    } satisfies RuntimeCredentialCostProfile;
  });
  const sessions = aggregateDimensions(report.breakdowns.conversations).map((item) => {
    const previous = item.id ? localSessions.get(item.id) : undefined;
    const taskCount = previous?.taskCount ?? 0;
    return {
      routerSessionId: item.id ?? "__unattributed__",
      totalInputTokens: item.inputTokens,
      totalOutputTokens: item.outputTokens,
      totalCostUsd: item.charge,
      totalActualCostUsd: item.settledCharge,
      taskCount,
      avgCostPerTask: taskCount > 0 ? item.charge / taskCount : 0,
      currency: item.currency,
    } satisfies SessionCostProfile;
  });
  const totalInputTokens = report.totals.reduce((sum, row) => sum + row.inputTokens, 0);
  const totalOutputTokens = report.totals.reduce((sum, row) => sum + row.outputTokens, 0);

  return {
    ...local,
    agents,
    runtimes,
    runtimeCredentials,
    sessions,
    totalCostUsd: singleCurrency?.estimatedCost ?? 0,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd: singleCurrency?.estimatedCost ?? 0,
    pendingReconciliationCostUsd: singleCurrency?.pendingReconciliationCost ?? 0,
    reconciledCostUsd: singleCurrency?.reconciledCost ?? 0,
    unallocatedCostUsd: singleCurrency?.unallocatedCost ?? 0,
    totalActualCostUsd: singleCurrency?.totalActualCost ?? 0,
    billingByCurrency,
    lastReconciledAt: report.period.endDate,
    billingReportState: "authoritative",
    reportCurrency: singleCurrency?.currency,
    modelCount: new Set(report.breakdowns.models.map((row) => row.id).filter(Boolean)).size,
    models: report.breakdowns.models
      .filter((row) => row.id)
      .map((row) => ({ modelId: row.id!, displayName: row.id!, inputPer1M: 0, outputPer1M: 0 })),
  };
}

export function getAgentCostProfileSync(
  agentId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
} {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getAgentCostSummarySync(agentId, since, workspaceId);
  return {
    ...summary,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export interface RuntimeCostProfile {
  runtimeId: string;
  displayName?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
  currency?: string;
}

export function getRuntimeCostProfileSync(
  runtimeId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getRuntimeCostSummarySync(runtimeId, since, workspaceId);
  return {
    runtimeId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listRuntimeCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summaries = listRuntimeCostSummariesSync(since, workspaceId);
  const displayNames = new Map(
    listWorkspaceRuntimeDisplayNamesSync(workspaceId).map((r) => [r.runtimeId, r.displayName.trim()]),
  );
  return summaries.map((s) => ({
    runtimeId: s.runtimeId,
    displayName: displayNames.get(s.runtimeId) || undefined,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}

export interface RuntimeCredentialCostProfile {
  runtimeCredentialId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
  currency?: string;
}

export function getRuntimeCredentialCostProfileSync(
  runtimeCredentialId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCredentialCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getRuntimeCredentialCostSummarySync(runtimeCredentialId, since, workspaceId);
  return {
    runtimeCredentialId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listRuntimeCredentialCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCredentialCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  return listRuntimeCredentialCostSummariesSync(since, workspaceId).map((s) => ({
    runtimeCredentialId: s.runtimeCredentialId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}

export interface SessionCostProfile {
  routerSessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
  currency?: string;
}

export function getSessionCostProfileSync(
  routerSessionId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): SessionCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getSessionCostSummarySync(routerSessionId, since, workspaceId);
  return {
    routerSessionId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listSessionCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): SessionCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  return listSessionCostSummariesSync(since, workspaceId).map((s) => ({
    routerSessionId: s.routerSessionId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}
