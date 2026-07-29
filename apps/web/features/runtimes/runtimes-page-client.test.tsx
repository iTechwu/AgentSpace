import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ManagedRuntimeListItem } from "@dofe-agent/services";
import { RuntimesPageClient } from "@/features/runtimes/runtimes-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/features/runtimes/actions", () => ({
  cancelProvisioningAction: vi.fn(),
  deleteManagedRuntimeAction: vi.fn(),
  retryProvisioningAction: vi.fn(),
  rotateManagedRuntimeCredentialAction: vi.fn(),
  stopManagedRuntimeAction: vi.fn(),
}));

vi.mock("@/features/runtimes/managed-runtime-list", () => ({
  ManagedRuntimeList: ({ runtimes }: { runtimes: ManagedRuntimeListItem[] }) => (
    <p>列表中的执行引擎：{runtimes.length}</p>
  ),
}));

vi.mock("@/features/runtimes/managed-runtime-creation-wizard", () => ({
  ManagedRuntimeCreationWizard: () => <p>新增执行引擎向导</p>,
}));

const runtime: ManagedRuntimeListItem = {
  id: "runtime-1",
  name: "Codex 172.30.30.11",
  provider: "codex",
  managedCredentialId: "credential-1",
  status: "online",
  provisioningState: "managed",
  protocols: ["openai"],
  assignedEmployeeCount: 1,
  periodActualCostUsd: 0,
  unallocatedCostUsd: 0,
};

function renderPage(initialRuntimes: ManagedRuntimeListItem[]) {
  return render(
    <LanguageProvider initialLanguage="zh">
      <RuntimesPageClient
        initialRuntimes={initialRuntimes}
        initialTasks={[]}
        isAdmin
        targetServers={[]}
        workspaceSlug="acme"
      />
    </LanguageProvider>,
  );
}

it("shows the runtime list first and keeps creation and operations in separate tabs", async () => {
  const user = userEvent.setup();
  renderPage([runtime]);

  expect(screen.getByRole("tab", { name: /执行引擎列表/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("列表中的执行引擎：1")).toBeInTheDocument();
  expect(screen.queryByText("新增执行引擎向导")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "新增执行引擎" }));
  expect(screen.getByRole("tab", { name: "新增执行引擎" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("新增执行引擎向导")).toBeInTheDocument();
  expect(screen.queryByText("暂无部署任务")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "运维详情" }));
  expect(screen.getByRole("tab", { name: "运维详情" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("运行概览")).toBeInTheDocument();
  expect(screen.getByText("暂无部署任务")).toBeInTheDocument();
});

it("opens the create tab directly when no runtime exists", () => {
  renderPage([]);

  expect(screen.getByRole("tab", { name: /新增执行引擎/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("新增执行引擎向导")).toBeInTheDocument();
  expect(screen.queryByText(/列表中的执行引擎/)).not.toBeInTheDocument();
});
