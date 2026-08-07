import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowListClient } from "./workflow-list-client";
import { runWorkflowAction } from "./workflow-actions";
import type { WorkflowCenterPageData } from "./workflow-types";

vi.mock("@/features/i18n/language-provider", () => ({ useLanguage: () => ({ tx: (zh: string) => zh }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./workflow-actions", () => ({ runWorkflowAction: vi.fn() }));

const data: WorkflowCenterPageData = {
  workflows: [{
    id: "wf-1", name: "每日简报", status: "published" as const, ownerLabel: "负责人", triggerLabelCode: "schedule",
    topology: { employeeNodeCount: 4, parallelGroupCount: 1, hasApproval: false },
    latestRun: { id: "run-1", status: "succeeded" as const, finishedAt: "2026-08-06T01:00:00.000Z" },
  }],
  totals: { all: 1, published: 1, paused: 0, blocked: 0 },
  recentRuns: [
    { id: "run-2", workflowId: "wf-1", workflowName: "每日简报", status: "failed" as const, triggerType: "schedule", createdAt: "2026-08-06T02:00:00.000Z", finishedAt: "2026-08-06T02:30:00.000Z" },
    { id: "run-1", workflowId: "wf-1", workflowName: "每日简报", status: "succeeded" as const, triggerType: "schedule", createdAt: "2026-08-06T00:00:00.000Z", finishedAt: "2026-08-06T01:00:00.000Z" },
  ],
  recentRunsTotal: 2,
};

describe("WorkflowListClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows plan run template tabs and links to the shared builder", () => {
    render(<WorkflowListClient data={data} workspaceId="ws-1" workspaceSlug="default" />);
    expect(screen.getByRole("tab", { name: "计划" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "运行" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "模板" })).toBeVisible();
    expect(screen.getByRole("link", { name: "新建编排" })).toHaveAttribute("href", "/w/default/automations/new?entry=automations");
  });

  it("filters plans and exposes the recent run history on the runs tab", async () => {
    const user = userEvent.setup();
    render(<WorkflowListClient data={data} workspaceId="ws-1" workspaceSlug="default" />);
    await user.type(screen.getByRole("searchbox", { name: "搜索" }), "不存在");
    expect(screen.getByText("暂无计划")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "运行" }));
    const runLinks = screen.getAllByRole("link", { name: /每日简报/ });
    expect(runLinks).toHaveLength(2);
    // 运行历史按创建时间倒序，最近的 run-2 排在最前。
    expect(runLinks[0]).toHaveAttribute("href", "/w/default/automations/runs/run-2");
    expect(runLinks[1]).toHaveAttribute("href", "/w/default/automations/runs/run-1");
  });

  it("shows an empty state when there is no run history", async () => {
    const user = userEvent.setup();
    render(<WorkflowListClient data={{ ...data, recentRuns: [] }} workspaceId="ws-1" workspaceSlug="default" />);
    await user.click(screen.getByRole("tab", { name: "运行" }));
    expect(screen.getByText("暂无运行")).toBeVisible();
  });

  it("loads more runs on demand via the paginated runs API", async () => {
    // 运行历史分页（UIUX:运行历史分页）：SSR 首页不足 total 时展示「加载更多」，
    // 点击后按 offset 请求分页接口并追加，不重复已加载运行。
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        runs: [
          { id: "run-3", workflowId: "wf-1", workflowName: "每日简报", status: "cancelled", triggerType: "schedule", createdAt: "2026-08-05T00:00:00.000Z" },
        ],
        total: 3,
        hasMore: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const paginated: WorkflowCenterPageData = { ...data, recentRunsTotal: 3 };
    const user = userEvent.setup();
    render(<WorkflowListClient data={paginated} workspaceId="ws-1" workspaceSlug="default" />);
    await user.click(screen.getByRole("tab", { name: "运行" }));

    // 首页 2 条 + total 3 → 展示「加载更多」与已加载计数。
    expect(screen.getByRole("button", { name: "加载更多" })).toBeEnabled();
    expect(screen.getByText(/已加载 2 \/ 3 条/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加载更多" }));

    // 追加 run-3 后，加载更多消失（已覆盖 total），并按 offset=2 请求下一页。
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws-1/workflow-runs?limit=50&offset=2",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(screen.getByText(/共 3 条运行记录/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    fetchMock.mockRestore();
  });

  it("surfaces a translated notice when a manual run fails", async () => {
    const manualData: WorkflowCenterPageData = {
      ...data,
      workflows: [{
        id: "wf-manual", name: "手动流", status: "published", ownerLabel: "负责人", triggerLabelCode: "manual",
        topology: { employeeNodeCount: 1, parallelGroupCount: 0, hasApproval: false },
      }],
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(runWorkflowAction).mockResolvedValue({
      ok: false,
      error: { code: "workflow_manual_trigger_required", message: "" },
    });
    const user = userEvent.setup();
    render(<WorkflowListClient data={manualData} workspaceId="ws-1" workspaceSlug="default" />);

    await user.click(screen.getByRole("button", { name: "立即运行" }));

    expect(screen.getByRole("status").textContent).toBe("只有已发布的手动触发工作流可以立即运行");
    expect(vi.mocked(runWorkflowAction)).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf-manual" }));
  });
});
