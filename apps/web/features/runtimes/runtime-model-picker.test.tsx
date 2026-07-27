import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { listProtocolFilteredRuntimeModelsAction } from "@/features/runtimes/actions";

vi.mock("@/features/runtimes/actions", () => ({
  listProtocolFilteredRuntimeModelsAction: vi.fn(),
}));

it("shows unavailable protocol-compatible models with their reason", async () => {
  vi.mocked(listProtocolFilteredRuntimeModelsAction).mockResolvedValue({
    configured: true,
    list: [
      {
        alias: "available-model",
        model: "available-model",
        protocol: "openai",
        isAvailable: true,
      },
      {
        alias: "disabled-model",
        model: "disabled-model",
        protocol: "openai",
        isAvailable: false,
        unavailableReason: "Disabled by team policy",
      },
    ],
  });

  render(<RuntimeModelPicker provider="codex" value="" onChange={vi.fn()} />);

  expect(await screen.findByRole("option", { name: "available-model" })).toBeEnabled();
  expect(screen.getByRole("option", { name: "disabled-model - Disabled by team policy" })).toBeDisabled();
});
