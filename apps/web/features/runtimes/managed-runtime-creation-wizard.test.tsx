import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
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
