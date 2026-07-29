import type { ReactNode } from "react";
import { render as testingRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ManagedRuntimeList } from "@/features/runtimes/managed-runtime-list";
import { LanguageProvider } from "@/features/i18n/language-provider";

function render(ui: ReactNode) {
  return testingRender(<LanguageProvider initialLanguage="en">{ui}</LanguageProvider>);
}

it("exposes manual credential rotation only when a runtime needs attention", async () => {
  const onRotate = vi.fn();
  const user = userEvent.setup();

  render(
    <ManagedRuntimeList
      pending={false}
      onRotate={onRotate}
      workspaceSlug="acme"
      runtimes={[
        {
          id: "runtime-ready",
          name: "Ready Codex",
          provider: "codex",
          managedCredentialId: "rtc-ready-1234567890",
          status: "online",
          provisioningState: "managed",
          protocols: ["openai"],
          defaultModel: "gpt-5",
          assignedEmployeeCount: 3,
          lastHeartbeatAt: "2026-07-28T01:00:00.000Z",
          periodActualCostUsd: 1.25,
          unallocatedCostUsd: 0,
        },
        {
          id: "runtime-attention",
          name: "Claude Worker",
          provider: "claude",
          managedCredentialId: "rtc-attention-1234567890",
          status: "offline",
          provisioningState: "needs_attention",
          protocols: ["anthropic"],
          defaultModel: "claude-sonnet",
          assignedEmployeeCount: 1,
          periodActualCostUsd: 2.5,
          unallocatedCostUsd: 0.2,
        },
      ]}
    />,
  );

  const table = screen.getByRole("table", { name: "Managed runtimes" });
  expect(screen.getByRole("link", { name: "Ready Codex" })).toHaveAttribute(
    "href",
    "/w/acme/runtimes/runtime/runtime-ready",
  );
  expect(within(table).getByText("Available")).toBeInTheDocument();
  expect(within(table).getByText("Needs attention")).toBeInTheDocument();
  expect(within(table).getByText("gpt-5")).toBeInTheDocument();
  expect(within(table).getByText("¥0.2000 unallocated")).toBeInTheDocument();
  const rotateButton = screen.getByRole("button", { name: "Rotate key" });
  await user.click(rotateButton);
  expect(onRotate).toHaveBeenCalledWith("runtime-attention");
});

it("filters runtimes by provider, status, model, and cost attribution", async () => {
  const user = userEvent.setup();
  render(<ManagedRuntimeList pending={false} onRotate={vi.fn()} runtimes={[
    { id: "r1", name: "Codex", provider: "codex", managedCredentialId: "c1", status: "online", provisioningState: "managed", protocols: ["openai"], defaultModel: "gpt-5", assignedEmployeeCount: 2, periodActualCostUsd: 1, unallocatedCostUsd: 0 },
    { id: "r2", name: "Claude", provider: "claude", managedCredentialId: "c2", status: "offline", provisioningState: "needs_attention", protocols: ["anthropic"], defaultModel: "sonnet", assignedEmployeeCount: 0, periodActualCostUsd: 2, unallocatedCostUsd: 0.5 },
  ]} />);
  await user.selectOptions(screen.getByLabelText("Provider"), "claude");
  const table = screen.getByRole("table", { name: "Managed runtimes" });
  expect(within(table).getByText("Claude")).toBeInTheDocument();
  expect(within(table).queryByText("Codex")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Cost attribution"), "allocated");
  expect(screen.getByText("No runtimes match these filters.")).toBeInTheDocument();
});

it("flags runtimes that have closed sharing to new AI employees", () => {
  render(<ManagedRuntimeList pending={false} onRotate={vi.fn()} runtimes={[
    { id: "r-open", name: "Open Codex", provider: "codex", managedCredentialId: "c1", status: "online", provisioningState: "managed", protocols: ["openai"], defaultModel: "gpt-5", assignedEmployeeCount: 3, periodActualCostUsd: 1, unallocatedCostUsd: 0, allowNewEmployeeSharing: true },
    { id: "r-closed", name: "Locked Claude", provider: "claude", managedCredentialId: "c2", status: "online", provisioningState: "managed", protocols: ["anthropic"], defaultModel: "claude", assignedEmployeeCount: 1, periodActualCostUsd: 0.5, unallocatedCostUsd: 0, allowNewEmployeeSharing: false },
  ]} />);

  const table = screen.getByRole("table", { name: "Managed runtimes" });
  const lockedRow = within(table).getByText("Locked Claude").closest("tr")!;
  const openRow = within(table).getByText("Open Codex").closest("tr")!;
  expect(within(lockedRow).getByText("Sharing closed to new AI employees")).toBeInTheDocument();
  expect(within(openRow).queryByText("Sharing closed to new AI employees")).not.toBeInTheDocument();
});
