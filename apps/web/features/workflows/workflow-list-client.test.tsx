import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowListClient } from "./workflow-list-client";
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
};

describe("WorkflowListClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows plan run template tabs and links to the shared builder", () => {
    render(<WorkflowListClient data={data} workspaceSlug="default" />);
    expect(screen.getByRole("tab", { name: "计划" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "运行" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "模板" })).toBeVisible();
    expect(screen.getByRole("link", { name: "新建编排" })).toHaveAttribute("href", "/w/default/automations/new?entry=automations");
  });

  it("filters plans and exposes the recent run history on the runs tab", async () => {
    const user = userEvent.setup();
    render(<WorkflowListClient data={data} workspaceSlug="default" />);
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
    render(<WorkflowListClient data={{ ...data, recentRuns: [] }} workspaceSlug="default" />);
    await user.click(screen.getByRole("tab", { name: "运行" }));
    expect(screen.getByText("暂无运行")).toBeVisible();
  });
});
