import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerformancePageClient } from "@/features/performance/performance-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { PerformanceDashboardData } from "@dofe-agent/services/finance";

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

const data: PerformanceDashboardData = {
  agents: [
    {
      agentId: "atlas",
      displayName: "Atlas",
      totalTasks: 12,
      completedTasks: 9,
      failedTasks: 1,
      completionRate: 0.75,
      errorRate: 0.08,
      avgResponseTimeMs: 3500,
      approvalCount: 4,
      rejectionCount: 1,
      satisfactionRate: 0.8,
    },
  ],
  totalTasks: 12,
  totalCompleted: 9,
  totalFailed: 1,
  overallCompletionRate: 0.75,
  overallErrorRate: 0.08,
  overallAvgResponseTimeMs: 3500,
};

describe("PerformancePageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it("uses balanced density with a compact table zone", () => {
    const { container } = render(
      <LanguageProvider>
        <PerformancePageClient data={data} />
      </LanguageProvider>,
    );

    expect(container.querySelector("[data-page-density='balanced'].performance-page")).toBeInTheDocument();
    expect(container.querySelector("[data-density-zone='compact'].performance-table-wrapper")).toBeInTheDocument();
  });

  it("renders performance metrics as cards instead of a table on compact layouts", () => {
    mockMatchMedia(true);

    render(
      <LanguageProvider>
        <PerformancePageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3.5s")).toBeInTheDocument();
  });
});
