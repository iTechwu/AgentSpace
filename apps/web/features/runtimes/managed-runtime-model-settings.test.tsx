import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ManagedRuntimeModelSettings } from "@/features/runtimes/managed-runtime-model-settings";
import {
  getManagedRuntimeModelsAction,
  updateManagedRuntimeDefaultModelAction,
} from "@/features/runtimes/actions";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/features/runtimes/actions", () => ({
  getManagedRuntimeModelsAction: vi.fn(),
  updateManagedRuntimeDefaultModelAction: vi.fn(),
}));

it("saves a runtime default while showing disabled models greyed out", async () => {
  vi.mocked(getManagedRuntimeModelsAction).mockResolvedValue({
    configured: true,
    catalogState: "ready",
    total: 2,
    list: [
      managedModel({ id: "model-1", alias: "gpt-5", displayName: "GPT-5", isAvailable: true, isEnabled: true }),
      managedModel({ id: "model-2", alias: "disabled", displayName: "Disabled", isAvailable: false, isEnabled: false, unavailableReason: "Disabled by team policy" }),
    ],
  });
  vi.mocked(updateManagedRuntimeDefaultModelAction).mockResolvedValue();

  const user = userEvent.setup();
  render(<ManagedRuntimeModelSettings runtimeId="runtime-1" />);

  const select = await screen.findByRole("button", { name: "默认模型" });
  await user.click(select);
  expect(screen.getByRole("option", { name: /GPT-5/ })).toBeInTheDocument();
  // A disabled language model stays visible but is greyed out / unselectable.
  expect(screen.getByRole("option", { name: /Disabled/ })).toBeDisabled();
  await user.click(screen.getByRole("option", { name: /GPT-5/ }));
  await user.click(screen.getByRole("button", { name: "保存模型" }));

  expect(updateManagedRuntimeDefaultModelAction).toHaveBeenCalledWith({
    runtimeId: "runtime-1",
    defaultModel: "gpt-5",
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it("shows unavailable models instead of an empty dropdown when none are usable", async () => {
  vi.mocked(getManagedRuntimeModelsAction).mockResolvedValue({
    configured: true,
    catalogState: "ready",
    total: 2,
    list: [
      managedModel({ id: "m1", alias: "claude", displayName: "Claude", isAvailable: false, isEnabled: true, unavailableReason: "Credential unavailable" }),
      managedModel({ id: "m2", alias: "gpt", displayName: "GPT", isAvailable: false, isEnabled: false, unavailableReason: "Disabled by team policy" }),
    ],
  });

  const user = userEvent.setup();
  render(<ManagedRuntimeModelSettings runtimeId="runtime-1" />);

  const select = await screen.findByRole("button", { name: "默认模型" });
  await user.click(select);
  // The dropdown is not empty: every catalog model is rendered, greyed out.
  expect(screen.getByRole("option", { name: /Claude/ })).toBeDisabled();
  expect(screen.getByRole("option", { name: /GPT/ })).toBeDisabled();
});

function managedModel(overrides: {
  id: string;
  alias: string;
  displayName: string;
  isAvailable: boolean;
  isEnabled: boolean;
  unavailableReason?: string;
}) {
  return {
    ...overrides,
    unavailableReason: overrides.unavailableReason,
    model: overrides.alias,
    modelType: "llm" as const,
    protocol: "openai_response",
    contextLength: 128_000,
    supportsVision: false,
    supportsFunctionCalling: true,
    inputPrice: null,
    outputPrice: null,
    priceCurrency: null,
  };
}
