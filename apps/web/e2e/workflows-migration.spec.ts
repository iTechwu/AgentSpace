import { expect, test } from "@playwright/test";
import {
  appendWorkflowRunEventSync,
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  listWorkflowDefinitionsSync,
  listWorkflowNodeRunsSync,
  listWorkflowRunsSync,
  materializeWorkflowNodeRunsSync,
  publishWorkflowVersionSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { openSeededWorkspacePage, type SeededWorkspaceSession } from "./helpers";

test("creates one plan for A to parallel B/C to summary D from the unified wizard", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/automations/new?entry=task-board");
  await page.getByLabel("工作流名称").filter({ visible: true }).fill("每日协作简报");
  await page.getByRole("navigation", { name: "创建步骤" }).getByRole("button", { name: /流程$/ }).click();

  await addEmployeeStep(page, session.agentName);
  await page.getByRole("button", { name: "并行分支", exact: true }).click();
  await page.getByLabel("并行起点").selectOption("employee-1");
  await selectEmployee(page, "并行员工 A", session.agentName);
  await selectEmployee(page, "并行员工 B", session.agentName);
  await page.getByRole("button", { name: "添加到流程" }).click();
  await addEmployeeStep(page, session.agentName);

  await page.getByRole("tab", { name: "列表" }).click();
  await page.getByTestId("node-join-2").getByRole("button").click();
  await page.getByRole("complementary", { name: "步骤配置" }).getByLabel("连接到").selectOption("employee-5");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();

  const workflow = listWorkflowDefinitionsSync(session.workspaceId).find((item) => item.name === "每日协作简报");
  expect(workflow).toBeTruthy();
  const graph = JSON.parse(workflow!.draftGraphJson) as WorkflowGraphDefinition;
  expect(graph.nodes.map((node) => node.id)).toEqual([
    "employee-1", "parallel-2-a", "parallel-2-b", "join-2", "employee-5",
  ]);
  expect(graph.edges).toContainEqual({ source: "join-2", target: "employee-5" });
});

test("shows an approval node waiting before downstream publication", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/automations");
  const fixture = seedRun(session, approvalGraph(session.agentName), "approval");
  transitionWorkflowNodeRunSync({
    workspaceId: session.workspaceId,
    nodeRunId: fixture.nodeRuns[0]!.id,
    from: ["pending"],
    to: "succeeded",
    finishedAt: fixture.now,
  });
  transitionWorkflowNodeRunSync({
    workspaceId: session.workspaceId,
    nodeRunId: fixture.nodeRuns[1]!.id,
    from: ["pending"],
    to: "waiting_approval",
    approvalId: `approval-${fixture.suffix}`,
  });
  transitionWorkflowRunSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    from: ["created"],
    to: "waiting_approval",
    startedAt: fixture.now,
  });
  appendWorkflowRunEventSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    type: "workflow.approval.requested",
    nodeRunId: fixture.nodeRuns[1]!.id,
    actorType: "system",
    dataJson: "{}",
  });

  await page.goto(`/w/${session.workspaceSlug}/automations/runs/${fixture.runId}`);
  await expect(page.locator(".workflow-run__header-status")).toHaveAttribute("data-status", "waiting_approval");
  await expect(page.locator('.workflow-run__node-status[data-status="waiting_approval"]')).toHaveCount(1);
  await expect(page.getByText("3 个节点")).toBeVisible();
});

test("offers a bounded retry when one parallel employee fails", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/automations");
  const fixture = seedRun(session, parallelGraph(session.agentName), "retry", 3);
  transitionWorkflowNodeRunSync({
    workspaceId: session.workspaceId,
    nodeRunId: fixture.nodeRuns[1]!.id,
    from: ["pending"],
    to: "failed",
    attemptCount: 1,
    errorCode: "workflow_runtime_offline",
    errorMessage: "redacted",
  });
  transitionWorkflowRunSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    from: ["created"],
    to: "running",
    startedAt: fixture.now,
  });
  transitionWorkflowRunSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    from: ["running"],
    to: "partially_succeeded",
    finishedAt: fixture.now,
  });

  await page.goto(`/w/${session.workspaceSlug}/automations/runs/${fixture.runId}`);
  await expect(page.getByRole("button", { name: "重试步骤" })).toBeVisible();
  expect(listWorkflowNodeRunsSync(session.workspaceId, fixture.runId)[1]!.maxAttempts).toBe(3);
});

test("deduplicates a recovered misfire after a worker stop", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/automations");
  const fixture = seedPublishedWorkflow(session, serialGraph(session.agentName), "misfire");
  const triggerKey = `schedule:${fixture.workflowId}:2026-08-06T09:00:00.000Z`;
  const first = createWorkflowRunSync({
    workspaceId: session.workspaceId,
    workflowId: fixture.workflowId,
    versionId: fixture.versionId,
    triggerType: "schedule",
    triggerKey,
    inputJson: "{}",
  });
  const recovered = createWorkflowRunSync({
    workspaceId: session.workspaceId,
    workflowId: fixture.workflowId,
    versionId: fixture.versionId,
    triggerType: "schedule",
    triggerKey,
    inputJson: "{}",
  });

  expect(recovered.id).toBe(first.id);
  expect(listWorkflowRunsSync(session.workspaceId).filter((run) => run.triggerKey === triggerKey)).toHaveLength(1);
  await page.goto(`/w/${session.workspaceSlug}/automations/runs/${first.id}`);
  await expect(page.getByText(`运行 ID ${first.id}`, { exact: false })).toBeVisible();
});

test("blocks retry when a failed node may have produced an external effect", async ({ page }) => {
  const session = await openSeededWorkspacePage(page, "/automations");
  const fixture = seedRun(session, serialGraph(session.agentName), "revoked");
  transitionWorkflowNodeRunSync({
    workspaceId: session.workspaceId,
    nodeRunId: fixture.nodeRuns[0]!.id,
    from: ["pending"],
    to: "failed",
    attemptCount: 1,
    errorCode: "workflow_completion_effect_uncertain",
    errorMessage: "redacted",
    finishedAt: fixture.now,
  });
  transitionWorkflowRunSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    from: ["created"],
    to: "failed",
    finishedAt: fixture.now,
  });
  appendWorkflowRunEventSync({
    workspaceId: session.workspaceId,
    runId: fixture.runId,
    type: "workflow.node.failed",
    nodeRunId: fixture.nodeRuns[0]!.id,
    actorType: "system",
    dataJson: JSON.stringify({ errorCode: "workflow_completion_effect_uncertain" }),
  });

  await page.goto(`/w/${session.workspaceSlug}/automations/runs/${fixture.runId}`);
  await expect(page.locator(".workflow-run__header-status")).toHaveAttribute("data-status", "failed");
  await expect(page.locator('.workflow-run__node-status[data-status="failed"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "重试步骤" })).toHaveCount(0);
});

async function addEmployeeStep(page: import("@playwright/test").Page, employeeName: string): Promise<void> {
  const palette = page.getByRole("complementary", { name: "步骤库" });
  const employeeStepButton = palette.locator("button.workflow-builder-palette__item").filter({ hasText: "AI 员工" }).first();
  await expect(employeeStepButton).toHaveAttribute("aria-label", "添加 AI 员工步骤");
  await employeeStepButton.click();
  await page.locator(".workflow-builder-add select").selectOption({ label: employeeName });
  await page.locator(".workflow-builder-add").getByRole("button", { name: "添加", exact: true }).click();
}

async function selectEmployee(
  page: import("@playwright/test").Page,
  selectName: string,
  employeeName: string,
): Promise<void> {
  const select = page.getByLabel(selectName);
  const value = await select.locator("option").filter({ hasText: employeeName }).getAttribute("value");
  expect(value).toBeTruthy();
  await select.selectOption(value!);
}

function seedRun(session: SeededWorkspaceSession, graph: WorkflowGraphDefinition, label: string, maxAttempts = 1) {
  const fixture = seedPublishedWorkflow(session, graph, label);
  const run = createWorkflowRunSync({
    workspaceId: session.workspaceId,
    workflowId: fixture.workflowId,
    versionId: fixture.versionId,
    triggerType: "manual",
    triggerKey: `e2e:${label}:${fixture.suffix}`,
    inputJson: "{}",
    createdBy: session.userId,
    now: fixture.now,
  });
  const nodeRuns = materializeWorkflowNodeRunsSync({
    workspaceId: session.workspaceId,
    runId: run.id,
    now: fixture.now,
    nodes: graph.nodes.map((node) => ({
      nodeId: node.id,
      nodeType: node.type,
      employeeId: node.employeeId,
      employeeNameSnapshot: node.type === "employee_task" ? session.agentName : node.type,
      maxAttempts,
    })),
  });
  return { ...fixture, runId: run.id, nodeRuns };
}

function seedPublishedWorkflow(session: SeededWorkspaceSession, graph: WorkflowGraphDefinition, label: string) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const definition = createWorkflowDefinitionSync({
    workspaceId: session.workspaceId,
    name: `E2E ${label} ${suffix}`,
    ownerUserId: session.userId,
    createdBy: session.userId,
    draftGraphJson: JSON.stringify(graph),
    now,
  });
  const version = publishWorkflowVersionSync({
    workspaceId: session.workspaceId,
    workflowId: definition.id,
    graphJson: JSON.stringify(graph),
    contentHash: `e2e-${label}-${suffix}`,
    publishedBy: session.userId,
    publishedAt: now,
  });
  return { suffix, now, workflowId: definition.id, versionId: version.id };
}

function serialGraph(employeeId: string): WorkflowGraphDefinition {
  return { schemaVersion: 1, nodes: [{ id: "a", type: "employee_task", employeeId, config: {} }], edges: [] };
}

function approvalGraph(employeeId: string): WorkflowGraphDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "a", type: "employee_task", employeeId, config: {} },
      { id: "approval", type: "approval", config: {} },
      { id: "publish", type: "employee_task", employeeId, config: {} },
    ],
    edges: [{ source: "a", target: "approval" }, { source: "approval", target: "publish" }],
  };
}

function parallelGraph(employeeId: string): WorkflowGraphDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "a", type: "employee_task", employeeId, config: {} },
      { id: "b", type: "employee_task", employeeId, config: {} },
      { id: "c", type: "employee_task", employeeId, config: {} },
      { id: "join", type: "join", config: { policy: "all_success" } },
      { id: "d", type: "employee_task", employeeId, config: {} },
    ],
    edges: [
      { source: "a", target: "b" }, { source: "a", target: "c" },
      { source: "b", target: "join" }, { source: "c", target: "join" },
      { source: "join", target: "d" },
    ],
  };
}
