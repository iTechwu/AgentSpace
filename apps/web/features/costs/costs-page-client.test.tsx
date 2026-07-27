import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostsPageClient } from "@/features/costs/costs-page-client";
import { upsertBudgetAction } from "@/features/costs/actions";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { BudgetPageData, CostPageData } from "@/features/dashboard/data";

const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefresh,
  }),
}));

vi.mock("@/features/costs/actions", () => ({
  upsertBudgetAction: vi.fn(async () => {}),
  toggleBudgetAction: vi.fn(async () => {}),
  deleteBudgetAction: vi.fn(async () => {}),
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const costs: CostPageData = {
  agents: [
    {
      agentId: "atlas",
      displayName: "Atlas",
      modelId: "gpt-5",
      totalCostUsd: 0.1234,
      totalInputTokens: 12345,
      totalOutputTokens: 6789,
      taskCount: 3,
      avgCostPerTask: 0.0411,
    },
  ],
  runtimes: [],
  runtimeCredentials: [],
  sessions: [],
  totalCostUsd: 0.1234,
  totalTasks: 3,
  totalInputTokens: 12345,
  totalOutputTokens: 6789,
  estimatedCostUsd: 0.1234,
  reconciledCostUsd: 0,
  unallocatedCostUsd: 0,
  totalActualCostUsd: 0,
  models: [],
  recentUsage: [
    {
      id: "usage-1",
      agentId: "atlas",
      modelId: "gpt-5",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      billingStatus: "estimated",
      createdAt: "2026-04-10T08:00:00.000Z",
    },
  ],
};

const budgets: BudgetPageData = {
  budgets: [],
  agents: [{ id: "atlas", name: "Atlas" }],
  channels: [{ name: "travel" }],
};

describe("CostsPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    routerRefresh.mockClear();
    vi.mocked(upsertBudgetAction).mockClear();
  });

  it("renders cost overview as cards instead of a table on compact layouts", () => {
    mockMatchMedia(true);

    render(
      <LanguageProvider>
        <CostsPageClient budgets={budgets} costs={costs} />
      </LanguageProvider>,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5")).toHaveLength(2);
    expect(screen.getByText("$0.1234")).toBeInTheDocument();
  });

  it("refreshes module data instead of the route after saving budgets in the workbench", async () => {
    const onDataChanged = vi.fn();
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <CostsPageClient budgets={budgets} costs={costs} onDataChanged={onDataChanged} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Budgets" }));
    await user.click(screen.getByRole("button", { name: "+ Add Budget" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(upsertBudgetAction).toHaveBeenCalledWith({
      action: "warn",
      limitUsd: 50,
      period: "monthly",
      scope: "workspace",
      scopeId: "global",
      warningThreshold: 0.8,
    });
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
