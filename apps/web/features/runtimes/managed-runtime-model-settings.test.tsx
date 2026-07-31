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

it("saves a runtime default, hiding non-llm entries but showing disabled ones greyed out", async () => {
  vi.mocked(getManagedRuntimeModelsAction).mockResolvedValue({
    configured: true,
    catalogState: "ready",
    total: 2,
    list: [
      { id: "model-1", alias: "gpt-5", displayName: "GPT-5", modelType: "llm", isAvailable: true, isEnabled: true },
      { id: "model-2", alias: "disabled", displayName: "Disabled", modelType: "llm", isAvailable: false, isEnabled: false, unavailableReason: "Disabled by team policy" },
      { id: "model-3", alias: "image-model", displayName: "Image model", modelType: "image", isAvailable: true, isEnabled: true },
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
  // Non-llm entries are still filtered out of the language-model picker.
  expect(screen.queryByRole("option", { name: "Image model" })).not.toBeInTheDocument();

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
      { id: "m1", alias: "claude", displayName: "Claude", modelType: "llm", isAvailable: false, isEnabled: true, unavailableReason: "Credential unavailable" },
      { id: "m2", alias: "gpt", displayName: "GPT", modelType: "llm", isAvailable: false, isEnabled: false, unavailableReason: "Disabled by team policy" },
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
