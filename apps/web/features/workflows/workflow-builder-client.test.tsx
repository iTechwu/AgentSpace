import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  validate: vi.fn(),
  publish: vi.fn(),
  controlDefinition: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("./workflow-actions", () => ({
  createWorkflowDraftAction: mocks.createDraft,
  controlWorkflowDefinitionAction: mocks.controlDefinition,
  updateWorkflowDraftAction: mocks.updateDraft,
  validateWorkflowAction: mocks.validate,
  publishWorkflowAction: mocks.publish,
}));
vi.mock("./workflow-canvas", () => ({
  WorkflowCanvas: ({ graph, errorNodeIds }: { graph: WorkflowGraphDefinition; errorNodeIds: string[] }) => (
    <div aria-label="流程画布">
      {graph.nodes.map((node) => <div data-error={errorNodeIds.includes(node.id)} data-testid={`node-${node.id}`} key={node.id}>{node.id}</div>)}
    </div>
  ),
}));

import { WorkflowBuilderClient } from "./workflow-builder-client";

const graph: WorkflowGraphDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: "source", type: "employee_task", employeeId: "emp-a", config: {} },
    { id: "audit", type: "employee_task", employeeId: "emp-b", config: {} },
    { id: "research", type: "employee_task", employeeId: "emp-c", config: {} },
    { id: "join", type: "join", config: { policy: "all_success" } },
    { id: "summary", type: "employee_task", employeeId: "emp-d", config: {} },
  ],
  edges: [
    { source: "source", target: "audit" },
    { source: "source", target: "research" },
    { source: "audit", target: "join" },
    { source: "research", target: "join" },
    { source: "join", target: "summary" },
  ],
};

const employees = ["a", "b", "c", "d"].map((suffix) => ({
  id: `emp-${suffix}`,
  name: `员工 ${suffix.toUpperCase()}`,
  status: "online",
}));

function renderBuilder(entry: "automations" | "calendar" | "task-board" = "automations", status: "draft" | "published" | "paused" = "draft") {
  return render(
    <WorkflowBuilderClient
      employees={employees}
      entry={entry}
      initial={{
        id: "wf-1",
        name: "并行审计",
        description: "",
        status,
        graph,
        draftVersion: 1,
        trigger: { type: "manual", config: {}, misfirePolicy: "skip" },
        governance: { maxConcurrency: 4 },
      }}
      workspaceSlug="default"
    />,
  );
}

describe("workflow builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validate.mockResolvedValue({
      ok: true,
      data: { blockers: [], warnings: [] },
      invalidation: { workspaceId: "workspace-1", modules: ["automations"] },
    });
    mocks.publish.mockResolvedValue({
      ok: true,
      data: { versionId: "version-1" },
      invalidation: { workspaceId: "workspace-1", modules: ["automations"] },
    });
    mocks.controlDefinition.mockResolvedValue({
      ok: true,
      data: { workflowId: "wf-1", status: "paused" },
      invalidation: { workspaceId: "workspace-1", modules: ["automations"] },
    });
  });

  it("preflights and publishes a serial plus parallel workflow", async () => {
    const user = userEvent.setup();
    renderBuilder("calendar");
    expect(screen.getByRole("heading", { name: "触发" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /5.*预览/ }));
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    expect(await screen.findByText("预检通过")).toBeVisible();

    const publish = screen.getByRole("button", { name: "发布" });
    expect(publish).toBeEnabled();
    await user.click(publish);
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "wf-1",
      expectedDraftVersion: 1,
      graph,
    })));
  });

  it("keeps the builder open and focuses a blocked employee node", async () => {
    const user = userEvent.setup();
    mocks.validate.mockResolvedValue({
      ok: true,
      data: { blockers: [{ code: "workflow_employee_not_ready", nodeId: "audit" }], warnings: [] },
      invalidation: { workspaceId: "workspace-1", modules: ["automations"] },
    });
    renderBuilder();

    await user.click(screen.getByRole("button", { name: /5.*预览/ }));
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    expect(await screen.findByText("AI 员工运行环境尚未就绪")).toBeVisible();
    expect(screen.getByRole("button", { name: "发布" })).toBeDisabled();
    expect(screen.getByTestId("node-audit")).toHaveAttribute("data-error", "true");
    expect(screen.getByRole("heading", { name: "流程" })).toBeVisible();
  });

  it("submits workflow concurrency and budget governance", async () => {
    const user = userEvent.setup();
    renderBuilder();
    await user.click(screen.getByRole("button", { name: /4.*治理/ }));
    await user.clear(screen.getByLabelText("最大并发数"));
    await user.type(screen.getByLabelText("最大并发数"), "2");
    await user.type(screen.getByLabelText("流程预算上限（USD）"), "12.5");
    await user.click(screen.getByRole("button", { name: /5.*预览/ }));
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await user.click(await screen.findByRole("button", { name: "发布" }));

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      governance: { maxConcurrency: 2, budgetUsd: 12.5 },
    })));
  });

  it("publishes the selected missed-run policy for schedules", async () => {
    const user = userEvent.setup();
    renderBuilder("calendar");
    await user.click(screen.getByRole("radio", { name: "定时触发" }));
    await user.selectOptions(screen.getByLabelText("错过执行"), "fire_once");
    await user.click(screen.getByRole("button", { name: /5.*预览/ }));
    await user.click(screen.getByRole("button", { name: "运行预检" }));
    await user.click(await screen.findByRole("button", { name: "发布" }));

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      trigger: expect.objectContaining({ type: "schedule", misfirePolicy: "fire_once" }),
    })));
  });

  it("pauses a published workflow from the builder header", async () => {
    const user = userEvent.setup();
    renderBuilder("automations", "published");

    await user.click(screen.getByRole("button", { name: "暂停" }));

    await waitFor(() => expect(mocks.controlDefinition).toHaveBeenCalledWith({ workflowId: "wf-1", action: "pause" }));
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
  });
});
