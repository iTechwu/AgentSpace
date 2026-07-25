import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  enqueueNativeTaskSync,
  recordTokenUsageSync,
  registerDaemonRuntimesSync,
  upsertBudgetSync,
} from "@dofe-agent/db";
import {
  bindEmployeeRuntimeSync,
  createEmployeeSync,
  resetWorkspaceStateSync,
} from "@dofe-agent/services";
import { runCostCommand } from "./cost.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-cost-command-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  resetWorkspaceStateSync("workspace-mars");
});

test("cost summary and budget list honor --workspace-id", () => {
  seedWorkspaceCosts("default", "default-ops", 1000, 500, 10);
  seedWorkspaceCosts("workspace-mars", "mars-ops", 4000, 1000, 20);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(typeof value === "string" ? value : String(value));
  };

  try {
    const summaryExitCode = runCostCommand("summary", ["--workspace-id", "workspace-mars"], "json");
    assert.equal(summaryExitCode, 0);
    const summary = JSON.parse(logs.pop() ?? "{}") as {
      agents: Array<{ agentId: string; costUsd: number }>;
    };
    assert.equal(summary.agents.length, 1);
    assert.equal(summary.agents[0]?.agentId, "Planner");
    assert.ok((summary.agents[0]?.costUsd ?? 0) > 0);

    const listExitCode = runCostCommand("budget", ["list", "--workspace-id", "workspace-mars"], "json");
    assert.equal(listExitCode, 0);
    const budgets = JSON.parse(logs.pop() ?? "[]") as Array<{ workspaceId: string; limitUsd: number }>;
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0]?.workspaceId, "workspace-mars");
    assert.equal(budgets[0]?.limitUsd, 20);
  } finally {
    console.log = originalLog;
  }
});

test.after(() => {
  process.chdir(originalCwd);
});

function seedWorkspaceCosts(
  workspaceId: string,
  channelName: string,
  inputTokens: number,
  outputTokens: number,
  limitUsd: number,
): void {
  createEmployeeSync({ name: "Planner" }, workspaceId);

  const runtime = registerDaemonRuntimesSync({
    workspaceId,
    daemonKey: `${workspaceId}-box`,
    deviceName: `${workspaceId}-box`,
    runtimes: [{ provider: "codex", name: `${workspaceId}-runtime` }],
  }).runtimes[0];
  assert.ok(runtime?.id);

  bindEmployeeRuntimeSync("Planner", runtime!.id, workspaceId);
  const task = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Planner",
    title: `${workspaceId}-task`,
    priority: "medium",
    channel: channelName,
  });
  assert.ok(task?.id);

  recordTokenUsageSync({
    workspaceId,
    taskQueueId: task!.id,
    agentId: "Planner",
    modelId: "gpt-4o",
    inputTokens,
    outputTokens,
    channelName,
  });

  upsertBudgetSync({
    workspaceId,
    scope: "workspace",
    scopeId: workspaceId,
    limitUsd,
    period: "monthly",
    action: "warn",
    warningThreshold: 0.5,
  });
}
