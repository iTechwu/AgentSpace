import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ManagedRuntimeCreationWizard } from "@/features/runtimes/managed-runtime-creation-wizard";
import {
  createManagedRuntimeAction,
  preflightManagedRuntimeAction,
} from "@/features/runtimes/actions";

vi.mock("@/features/runtimes/actions", () => ({
  createManagedRuntimeAction: vi.fn(async () => ({ taskId: "task-created" })),
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
  vi.mocked(createManagedRuntimeAction).mockResolvedValue({ taskId: "task-created" });
  vi.mocked(preflightManagedRuntimeAction).mockResolvedValue({
    allowed: true,
    availableBalance: "42.00",
    currency: "USD",
  });
});

it("creates a runtime only after completing the three-step preflight", async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  render(<ManagedRuntimeCreationWizard onCreated={onCreated} />);

  await user.type(screen.getByLabelText("Runtime name"), "Research Runtime");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("Compatible model catalog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Review" }));

  expect(await screen.findByText("Preflight passed")).toBeInTheDocument();
  expect(screen.getByText("Available balance: 42.00 USD")).toBeInTheDocument();
  expect(preflightManagedRuntimeAction).toHaveBeenCalledWith({
    provider: "claude",
    defaultModel: undefined,
  });

  await user.click(screen.getByRole("button", { name: "Create runtime" }));
  expect(createManagedRuntimeAction).toHaveBeenCalledWith(expect.objectContaining({
    provider: "claude",
    name: "Research Runtime",
  }));
  expect(onCreated).toHaveBeenCalledWith("task-created");
});

it("uses a new idempotency key after a failed request is reconfigured", async () => {
  const user = userEvent.setup();
  vi.mocked(createManagedRuntimeAction)
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValueOnce({ taskId: "task-retried" });
  render(<ManagedRuntimeCreationWizard onCreated={vi.fn()} />);

  await user.type(screen.getByLabelText("Runtime name"), "Initial Runtime");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Preflight passed");
  await user.click(screen.getByRole("button", { name: "Create runtime" }));
  await screen.findByRole("alert");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.clear(screen.getByLabelText("Runtime name"));
  await user.type(screen.getByLabelText("Runtime name"), "Updated Runtime");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Preflight passed");
  await user.click(screen.getByRole("button", { name: "Create runtime" }));

  const firstKey = vi.mocked(createManagedRuntimeAction).mock.calls[0]?.[0].idempotencyKey;
  const secondKey = vi.mocked(createManagedRuntimeAction).mock.calls[1]?.[0].idempotencyKey;
  expect(firstKey).toMatch(/^ui:claude:/);
  expect(secondKey).toMatch(/^ui:claude:/);
  expect(secondKey).not.toBe(firstKey);
});
