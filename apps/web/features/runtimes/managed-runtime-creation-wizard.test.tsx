import type { ReactNode } from "react";
import { render as testingRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ManagedRuntimeCreationWizard } from "@/features/runtimes/managed-runtime-creation-wizard";
import {
  createManagedRuntimeAction,
  preflightManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { LanguageProvider } from "@/features/i18n/language-provider";

function render(ui: ReactNode) {
  return testingRender(<LanguageProvider initialLanguage="en">{ui}</LanguageProvider>);
}

vi.mock("@/features/runtimes/actions", () => ({
  createManagedRuntimeAction: vi.fn(async () => ({ kind: "provisioning", taskId: "task-created" })),
  preflightManagedRuntimeAction: vi.fn(async () => ({
    allowed: true,
    availableBalance: "42.00",
    currency: "USD",
  })),
}));

vi.mock("@/features/runtimes/runtime-model-picker", () => ({
  RuntimeModelPicker: () => <p>Compatible model catalog</p>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createManagedRuntimeAction).mockResolvedValue({ kind: "provisioning", taskId: "task-created" });
  vi.mocked(preflightManagedRuntimeAction).mockResolvedValue({
    allowed: true,
    availableBalance: "42.00",
    currency: "USD",
  });
});

it("configures capacity with infrastructure controls hidden under advanced settings", async () => {
  const user = userEvent.setup();
  const onResolved = vi.fn();
  render(<ManagedRuntimeCreationWizard onResolved={onResolved} targetServers={[{ deviceName: "runner-a", status: "online" }]} />);

  expect(screen.queryByLabelText("Runtime name")).not.toBeVisible();
  expect(screen.queryByLabelText("Target execution node")).not.toBeVisible();
  await user.click(screen.getByText("Advanced settings"));
  await user.type(screen.getByLabelText("Runtime name"), "Research Runtime");
  await user.selectOptions(screen.getByLabelText("Target execution node"), "runner-a");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Compatible model catalog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review" }));

  expect(await screen.findByText("Ready to deploy")).toBeInTheDocument();
  expect(screen.getByText("Available balance: 42.00 USD")).toBeInTheDocument();
  expect(preflightManagedRuntimeAction).toHaveBeenCalledWith({
    provider: "claude",
    defaultModel: undefined,
    forceProvisioning: false,
  });

  await user.click(screen.getByRole("button", { name: "Configure capacity" }));
  expect(createManagedRuntimeAction).toHaveBeenCalledWith(expect.objectContaining({
    provider: "claude",
    name: "Research Runtime",
    targetServer: "runner-a",
    forceProvisioning: false,
  }));
  expect(onResolved).toHaveBeenCalledWith({ kind: "provisioning", taskId: "task-created" });
});

it("shows compatible shared capacity and returns the reused runtime", async () => {
  const user = userEvent.setup();
  const onResolved = vi.fn();
  vi.mocked(preflightManagedRuntimeAction).mockResolvedValue({
    allowed: true,
    reusableRuntime: { id: "runtime-shared", name: "Shared Claude" },
  });
  vi.mocked(createManagedRuntimeAction).mockResolvedValue({
    kind: "reused",
    runtimeId: "runtime-shared",
    runtimeName: "Shared Claude",
  });
  render(<ManagedRuntimeCreationWizard onResolved={onResolved} />);

  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByText("Shared capacity available")).toBeInTheDocument();
  expect(screen.getByText("Shared Claude")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Configure capacity" }));
  expect(onResolved).toHaveBeenCalledWith({
    kind: "reused",
    runtimeId: "runtime-shared",
    runtimeName: "Shared Claude",
  });
});

it("uses Terra as the Codex default without sending a single-model allowlist", async () => {
  const user = userEvent.setup();
  render(<ManagedRuntimeCreationWizard onResolved={vi.fn()} />);

  await user.selectOptions(screen.getByLabelText("Capacity type"), "codex");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Ready to deploy");

  expect(preflightManagedRuntimeAction).toHaveBeenCalledWith({
    provider: "codex",
    defaultModel: "gpt-5.6-terra",
    forceProvisioning: false,
  });
  await user.click(screen.getByRole("button", { name: "Configure capacity" }));
  const createInput = vi.mocked(createManagedRuntimeAction).mock.calls[0]?.[0];
  expect(createInput).toEqual(expect.objectContaining({
    provider: "codex",
    defaultModel: "gpt-5.6-terra",
  }));
  expect(createInput).not.toHaveProperty("allowedModels");
});

it("uses a new idempotency key after a failed request is reconfigured", async () => {
  const user = userEvent.setup();
  vi.mocked(createManagedRuntimeAction)
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValueOnce({ kind: "provisioning", taskId: "task-retried" });
  render(<ManagedRuntimeCreationWizard onResolved={vi.fn()} />);

  await user.click(screen.getByText("Advanced settings"));
  await user.type(screen.getByLabelText("Runtime name"), "Initial Runtime");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Ready to deploy");
  await user.click(screen.getByRole("button", { name: "Configure capacity" }));
  await screen.findByRole("alert");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByText("Advanced settings"));
  await user.clear(screen.getByLabelText("Runtime name"));
  await user.type(screen.getByLabelText("Runtime name"), "Updated Runtime");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Ready to deploy");
  await user.click(screen.getByRole("button", { name: "Configure capacity" }));

  const firstKey = vi.mocked(createManagedRuntimeAction).mock.calls[0]?.[0].idempotencyKey;
  const secondKey = vi.mocked(createManagedRuntimeAction).mock.calls[1]?.[0].idempotencyKey;
  expect(firstKey).toMatch(/^ui:claude:/);
  expect(secondKey).toMatch(/^ui:claude:/);
  expect(secondKey).not.toBe(firstKey);
});
