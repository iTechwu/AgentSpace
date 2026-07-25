import {
  DEFAULT_WORKSPACE_ID,
  listTokenUsageSync,
  getAgentCostSummarySync,
  getWorkspaceCostSummarySync,
  listModelPricingSync,
  getMonthStartIso,
} from "@dofe-agent/db";
import {
  listBudgetsWithSpentSync,
  upsertBudgetSync,
  toggleBudgetSync,
  deleteBudgetSync,
  checkAllBudgetsForAgentSync,
} from "@dofe-agent/services";
import type { BudgetAction, BudgetPeriod, BudgetScope } from "@dofe-agent/db";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runCostCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "summary") {
    return runCostSummary(args, format);
  }

  if (subcommand === "agent") {
    return runCostAgent(args, format);
  }

  if (subcommand === "recent") {
    return runCostRecent(args, format);
  }

  if (subcommand === "pricing") {
    writeData(format, listModelPricingSync());
    return 0;
  }

  if (subcommand === "budget") {
    return runBudgetCommand(args, format);
  }

  console.error("Usage: dofe-agent cost summary [--workspace-id <id>] [--period monthly|total] [--json]");
  console.error("   or: dofe-agent cost agent --name <agent> [--workspace-id <id>] [--period monthly|total] [--json]");
  console.error("   or: dofe-agent cost recent [--workspace-id <id>] [--agent <name>] [--limit <n>] [--json]");
  console.error("   or: dofe-agent cost pricing [--json]");
  console.error("   or: dofe-agent cost budget list [--workspace-id <id>] [--json]");
  console.error("   or: dofe-agent cost budget set --scope <workspace|agent|channel> [--scope-id <id>] --workspace-id <id> --limit <usd> [--period monthly|total] [--action warn|pause|approve] [--threshold <0-1>] [--json]");
  console.error("   or: dofe-agent cost budget toggle --id <budget-id> [--workspace-id <id>] --enabled true|false [--json]");
  console.error("   or: dofe-agent cost budget delete --id <budget-id> [--workspace-id <id>] [--json]");
  console.error("   or: dofe-agent cost budget check --agent <name> [--workspace-id <id>] [--channel <name>] [--json]");
  return 1;
}

function runCostSummary(args: string[], format: OutputFormat): number {
  const { flags } = parseArgs(args);
  const periodFlag = getStringFlag(flags, "period");
  const workspaceId = resolveWorkspaceIdFlag(flags);
  const since = periodFlag === "total" ? undefined : getMonthStartIso();
  const summaries = getWorkspaceCostSummarySync(since, workspaceId);

  const totalCost = summaries.reduce((sum, s) => sum + s.totalCostUsd, 0);
  const totalTasks = summaries.reduce((sum, s) => sum + s.taskCount, 0);
  const totalInput = summaries.reduce((sum, s) => sum + s.totalInputTokens, 0);
  const totalOutput = summaries.reduce((sum, s) => sum + s.totalOutputTokens, 0);

  writeData(format, {
    period: periodFlag === "total" ? "total" : "monthly",
    totalCostUsd: Math.round(totalCost * 10000) / 10000,
    totalTasks,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    agents: summaries.map((s) => ({
      agentId: s.agentId,
      modelId: s.modelId,
      costUsd: Math.round(s.totalCostUsd * 10000) / 10000,
      tasks: s.taskCount,
      inputTokens: s.totalInputTokens,
      outputTokens: s.totalOutputTokens,
    })),
  });
  return 0;
}

function runCostAgent(args: string[], format: OutputFormat): number {
  const { flags } = parseArgs(args);
  const name = getStringFlag(flags, "name");
  if (!name) {
    console.error("Usage: dofe-agent cost agent --name <agent> [--period monthly|total] [--json]");
    return 1;
  }

  const periodFlag = getStringFlag(flags, "period");
  const workspaceId = resolveWorkspaceIdFlag(flags);
  const since = periodFlag === "total" ? undefined : getMonthStartIso();
  const summary = getAgentCostSummarySync(name, since, workspaceId);

  writeData(format, {
    agentId: name,
    period: periodFlag === "total" ? "total" : "monthly",
    ...summary,
    avgCostPerTask: summary.taskCount > 0
      ? Math.round((summary.totalCostUsd / summary.taskCount) * 10000) / 10000
      : 0,
  });
  return 0;
}

function runCostRecent(args: string[], format: OutputFormat): number {
  const { flags } = parseArgs(args);
  const agentId = getStringFlag(flags, "agent") ?? undefined;
  const workspaceId = resolveWorkspaceIdFlag(flags);
  const limitRaw = getStringFlag(flags, "limit");
  const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw), 100)) : 20;

  const usages = listTokenUsageSync({ agentId, workspaceId }).slice(0, limit);
  writeData(format, usages);
  return 0;
}

function runBudgetCommand(args: string[], format: OutputFormat): number {
  const { positionals, flags } = parseArgs(args);
  const action = positionals[0];
  const workspaceId = resolveWorkspaceIdFlag(flags);

  if (action === "list" || !action) {
    writeData(format, listBudgetsWithSpentSync(workspaceId));
    return 0;
  }

  if (action === "set") {
    const scope = getStringFlag(flags, "scope") as BudgetScope | undefined;
    const scopeId = getStringFlag(flags, "scope-id");
    const limitRaw = getStringFlag(flags, "limit");

    if (!scope || !limitRaw || (scope !== "workspace" && !scopeId)) {
      console.error("Usage: dofe-agent cost budget set --scope <workspace|agent|channel> [--scope-id <id>] --limit <usd> [--period monthly|total] [--action warn|pause|approve] [--threshold <0-1>] [--json]");
      return 1;
    }

    if (!["workspace", "agent", "channel"].includes(scope)) {
      console.error("Scope must be one of: workspace, agent, channel");
      return 1;
    }

    const limitUsd = parseFloat(limitRaw);
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      console.error("Limit must be a non-negative number.");
      return 1;
    }

    const period = (getStringFlag(flags, "period") ?? "monthly") as BudgetPeriod;
    const budgetAction = (getStringFlag(flags, "action") ?? "warn") as BudgetAction;
    const threshold = parseFloat(getStringFlag(flags, "threshold") ?? "0.8");

    const budget = upsertBudgetSync({
      workspaceId,
      scope,
      scopeId: scopeId ?? workspaceId,
      limitUsd,
      period,
      action: budgetAction,
      warningThreshold: Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0.8,
    });

    writeData(format, { ok: true, budget });
    return 0;
  }

  if (action === "toggle") {
    const id = getStringFlag(flags, "id");
    const enabledRaw = getStringFlag(flags, "enabled");
    if (!id || !enabledRaw) {
      console.error("Usage: dofe-agent cost budget toggle --id <budget-id> --enabled true|false [--json]");
      return 1;
    }
    toggleBudgetSync(id, enabledRaw === "true", workspaceId);
    writeData(format, { ok: true, id, enabled: enabledRaw === "true" });
    return 0;
  }

  if (action === "delete") {
    const id = getStringFlag(flags, "id");
    if (!id) {
      console.error("Usage: dofe-agent cost budget delete --id <budget-id> [--json]");
      return 1;
    }
    deleteBudgetSync(id, workspaceId);
    writeData(format, { ok: true, id });
    return 0;
  }

  if (action === "check") {
    const agent = getStringFlag(flags, "agent");
    if (!agent) {
      console.error("Usage: dofe-agent cost budget check --agent <name> [--channel <name>] [--json]");
      return 1;
    }
    const channel = getStringFlag(flags, "channel") ?? undefined;
    const result = checkAllBudgetsForAgentSync(agent, channel, workspaceId);
    writeData(format, result);
    return 0;
  }

  console.error("Unknown budget subcommand. Use: list, set, toggle, delete, check");
  return 1;
}

function resolveWorkspaceIdFlag(flags: Record<string, string | boolean>): string {
  return getStringFlag(flags, "workspace-id") ?? DEFAULT_WORKSPACE_ID;
}
