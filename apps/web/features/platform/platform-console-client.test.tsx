import type { ReactNode } from "react";
import { render as testingRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { PlatformConsoleClient, type PlatformWorkspaceSummary } from "@/features/platform/platform-console-client";
import { PlatformConsoleShell } from "@/features/platform/platform-console-shell";

const workspaces: PlatformWorkspaceSummary[] = [
  {
    workspaceId: "ws-green",
    slug: "green-team",
    name: "Green Team",
    managedRuntimeCount: 4,
    onlineRuntimeCount: 4,
    needsAttentionRuntimeCount: 0,
    periodActualCostUsd: 2.5,
  },
  {
    workspaceId: "ws-attention",
    slug: "attention-team",
    name: "Attention Team",
    managedRuntimeCount: 3,
    onlineRuntimeCount: 2,
    needsAttentionRuntimeCount: 1,
    periodActualCostUsd: 9.75,
  },
  {
    workspaceId: "ws-empty",
    slug: "empty-team",
    name: "Empty Team",
    managedRuntimeCount: 0,
    onlineRuntimeCount: 0,
    needsAttentionRuntimeCount: 0,
    periodActualCostUsd: 0,
  },
];

function renderConsole(): void {
  const ui: ReactNode = (
    <PlatformConsoleClient
      operator={{ displayName: "Operator" }}
      periodLabel="2026年7月"
      recentAudit={[]}
      workspaces={workspaces}
    />
  );
  testingRender(ui);
}

it("summarizes platform health and links each workspace to its runtime view", () => {
  renderConsole();

  expect(screen.getByText("平台运维控制台")).toBeInTheDocument();
  expect(screen.getByText("需要介入")).toBeInTheDocument();
  expect(screen.getByText("影响 1 个工作区")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看 Attention Team 的 Runtime" })).toHaveAttribute(
    "href",
    "/w/attention-team/runtimes",
  );
});

it("shows the operator identity instead of an email address", () => {
  renderConsole();

  expect(screen.getByText("平台管理员")).toBeInTheDocument();
  expect(screen.queryByText(/operator@example\.com/)).not.toBeInTheDocument();
});

it("keeps the platform navigation and marks audit as the current page", () => {
  testingRender(
    <PlatformConsoleShell activeSection="audit" operator={{ displayName: "Operator" }}>
      <div>审计内容</div>
    </PlatformConsoleShell>,
  );

  expect(screen.getByRole("navigation", { name: "平台运维导航" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "平台审计" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "运行概览" })).not.toHaveAttribute("aria-current");
});

it("filters by attention and searches workspace names", async () => {
  const user = userEvent.setup();
  renderConsole();
  const table = screen.getByRole("table", { name: "工作区运行状态" });

  await user.click(screen.getByRole("button", { name: "需处理" }));
  expect(within(table).getByText("Attention Team")).toBeInTheDocument();
  expect(within(table).queryByText("Green Team")).not.toBeInTheDocument();

  const search = screen.getByRole("searchbox", { name: "搜索工作区" });
  await user.clear(search);
  await user.type(search, "empty");
  expect(within(table).queryByText("Attention Team")).not.toBeInTheDocument();
  expect(within(table).queryByText("Empty Team")).not.toBeInTheDocument();
  expect(screen.getByText("没有符合条件的工作区")).toBeInTheDocument();
});

it("sorts workspace rows by cost when selected", async () => {
  const user = userEvent.setup();
  renderConsole();
  const table = screen.getByRole("table", { name: "工作区运行状态" });
  await user.selectOptions(screen.getByLabelText("排序"), "cost");
  const rows = within(table).getAllByRole("row");
  expect(within(rows[1]!).getByText("Attention Team")).toBeInTheDocument();
});
