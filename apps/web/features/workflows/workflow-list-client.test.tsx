import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowListClient } from "./workflow-list-client";

vi.mock("@/features/i18n/language-provider", () => ({ useLanguage: () => ({ tx: (zh: string) => zh }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./workflow-actions", () => ({ runWorkflowAction: vi.fn() }));

const data = {
  workflows: [{
    id: "wf-1", name: "每日简报", status: "published" as const, ownerLabel: "负责人", triggerLabelCode: "schedule",
    topology: { employeeNodeCount: 4, parallelGroupCount: 1, hasApproval: false },
    latestRun: { id: "run-1", status: "succeeded" as const, finishedAt: "2026-08-06T01:00:00.000Z" },
  }],
  totals: { all: 1, published: 1, paused: 0, blocked: 0 },
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

  it("filters plans and exposes the latest run tab", async () => {
    const user = userEvent.setup();
    render(<WorkflowListClient data={data} workspaceSlug="default" />);
    await user.type(screen.getByRole("searchbox", { name: "搜索" }), "不存在");
    expect(screen.getByText("暂无计划")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "运行" }));
    expect(screen.getByRole("link", { name: /每日简报/ })).toHaveAttribute("href", "/w/default/automations/runs/run-1");
  });
});
