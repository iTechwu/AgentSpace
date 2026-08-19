import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgChartPageData } from "@/features/dashboard/data";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { OrgChartPageClient } from "./org-chart-page-client";

const orgChartData: OrgChartPageData = {
  humans: [
    {
      id: "human-1",
      name: "吴敏",
      displayName: "吴敏",
      role: "管理员",
      type: "human",
      channels: ["全体"],
      status: "online",
    },
  ],
  agents: [
    {
      id: "Codex E2E",
      name: "Codex E2E",
      displayName: "Codex E2E",
      role: "Agent",
      type: "agent",
      channels: ["全体", "研发"],
      status: "online",
    },
    {
      id: "Claude E2E",
      name: "Claude E2E",
      displayName: "Claude E2E",
      role: "Agent",
      type: "agent",
      channels: ["全体"],
      status: "offline",
    },
  ],
  channels: [
    { name: "全体", agentNames: ["Codex E2E", "Claude E2E"] },
    { name: "研发", agentNames: ["Codex E2E"] },
  ],
  totalHumans: 1,
  totalAgents: 2,
};

function renderOrgChart(data: OrgChartPageData = orgChartData) {
  return render(
    <LanguageProvider initialLanguage="zh">
      <OrgChartPageClient data={data} />
    </LanguageProvider>,
  );
}

describe("OrgChartPageClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the workspace, organization units, and members as one hierarchy", () => {
    renderOrgChart();

    const tree = screen.getByRole("tree", { name: "工作区组织架构" });
    expect(within(tree).getByRole("treeitem", { name: /工作区全体/ })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /人类团队/ })).toBeInTheDocument();
    expect(within(tree).getByRole("treeitem", { name: /AI 员工团队/ })).toBeInTheDocument();
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(6);
    expect(within(tree).getByText("吴敏")).toBeInTheDocument();
    expect(within(tree).getByText("Codex E2E")).toBeInTheDocument();
    expect(within(tree).getByText("Claude E2E")).toBeInTheDocument();
  });

  it("switches to the group view with accessible tab state", async () => {
    const user = userEvent.setup();
    renderOrgChart();

    const treeTab = screen.getByRole("tab", { name: "组织树" });
    const channelTab = screen.getByRole("tab", { name: "按群组" });
    expect(treeTab).toHaveAttribute("aria-selected", "true");

    await user.click(channelTab);

    expect(channelTab).toHaveAttribute("aria-selected", "true");
    expect(treeTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "按群组" })).toHaveTextContent("研发");
  });

  it("centers an overflowing hierarchy on its organization root", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1200);

    renderOrgChart();

    expect(screen.getByRole("tabpanel", { name: "组织树" })).toHaveProperty("scrollLeft", 300);
  });
});
