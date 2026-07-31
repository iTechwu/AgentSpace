import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostsPageClient } from "@/features/costs/costs-page-client";
import { getTeamBillingBalanceAction, upsertBudgetAction } from "@/features/costs/actions";
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
  getTeamBillingBalanceAction: vi.fn(async () => ({ balance: "100.00", reservedBalance: "10.00", availableBalance: "90.00", currency: "USD", status: "active" })),
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
  pendingReconciliationCostUsd: 0.02,
  reconciledCostUsd: 0,
  unallocatedCostUsd: 0,
  totalActualCostUsd: 0,
  billingByCurrency: [
    {
      currency: "EUR",
      estimatedCost: 0.1234,
      pendingReconciliationCost: 0.02,
      reconciledCost: 0,
      unallocatedCost: 0,
      totalActualCost: 0,
    },
  ],
  models: [],
  recentUsage: [
    {
      id: "usage-1",
      agentId: "atlas",
      modelId: "gpt-5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheTokens: 0,
      costUsd: 0.01,
      billingStatus: "pending_reconciliation",
      actualCostUsd: 0.02,
      currency: "EUR",
      sourceUpdatedAt: "2026-04-10T08:05:00.000Z",
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
    vi.mocked(getTeamBillingBalanceAction).mockClear();
    vi.mocked(getTeamBillingBalanceAction).mockResolvedValue({ balance: "100.00", reservedBalance: "10.00", availableBalance: "90.00", currency: "USD", status: "active" });
  });

  it("renders cost overview as cards instead of a table on compact layouts", async () => {
    mockMatchMedia(true);

    render(
      <LanguageProvider>
        <CostsPageClient budgets={budgets} costs={costs} />
      </LanguageProvider>,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5")).toHaveLength(2);
    expect(screen.getByText("0.1234 EUR")).toBeInTheDocument();
    await screen.findByText("100.00 USD");
  });

  it("shows the actual team billing balance returned by models", async () => {
    render(<LanguageProvider><CostsPageClient budgets={budgets} costs={costs} /></LanguageProvider>);
    expect(await screen.findByText("100.00 USD")).toBeInTheDocument();
    expect(screen.getByText("可用: 90.00 USD")).toBeInTheDocument();
  });

  it("shows pending usage with its billing currency and update state", async () => {
    render(<LanguageProvider><CostsPageClient budgets={budgets} costs={costs} /></LanguageProvider>);

    await screen.findByText("100.00 USD");
    expect(screen.getAllByText("等待账单").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.0200 EUR").length).toBeGreaterThan(0);
    expect(screen.queryByText(/¥0\.0100/)).not.toBeInTheDocument();
    expect(screen.getByText(/更新时间/)).toBeInTheDocument();
  });

  it("labels legacy unknown usage as unattributed instead of an AI employee", async () => {
    const unattributedCosts: CostPageData = {
      ...costs,
      recentUsage: costs.recentUsage.map((usage) => ({
        ...usage,
        agentId: "unknown",
        billingStatus: "unallocated",
      })),
    };

    render(<LanguageProvider><CostsPageClient budgets={budgets} costs={unattributedCosts} /></LanguageProvider>);

    await screen.findByText("100.00 USD");
    expect(screen.getByText("未归属用量")).toBeInTheDocument();
    expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
  });

  it("shows an actionable reason when models billing is unavailable", async () => {
    vi.mocked(getTeamBillingBalanceAction).mockResolvedValue({ errorCode: "upstream_unavailable" } as never);
    render(<LanguageProvider><CostsPageClient budgets={budgets} costs={costs} /></LanguageProvider>);

    await screen.findByText("models 账单服务不可用");
  });

  it("shows an actionable reason when the balance action rejects", async () => {
    vi.mocked(getTeamBillingBalanceAction).mockRejectedValue(new Error("network unavailable"));
    render(<LanguageProvider><CostsPageClient budgets={budgets} costs={costs} /></LanguageProvider>);

    await screen.findByText("models 账单服务不可用");
  });

  it("refreshes module data instead of the route after saving budgets in the workbench", async () => {
    const onDataChanged = vi.fn();
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <CostsPageClient budgets={budgets} costs={costs} onDataChanged={onDataChanged} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "预算管理" }));
    await user.click(screen.getByRole("button", { name: "+ 添加预算" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

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
