import type { ReactNode } from "react";
import { act, render as testingRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { listProtocolFilteredRuntimeModelsAction } from "@/features/runtimes/actions";
import { LanguageProvider } from "@/features/i18n/language-provider";

function render(ui: ReactNode) {
  return testingRender(<LanguageProvider initialLanguage="en">{ui}</LanguageProvider>);
}

function renderChinese(ui: ReactNode) {
  window.localStorage.clear();
  return testingRender(<LanguageProvider initialLanguage="zh">{ui}</LanguageProvider>);
}

vi.mock("@/features/runtimes/actions", () => ({
  listProtocolFilteredRuntimeModelsAction: vi.fn(),
}));

it("searches models and shows unavailable protocol-compatible models with their reason", async () => {
  vi.mocked(listProtocolFilteredRuntimeModelsAction).mockResolvedValue({
    configured: true,
    list: [
      {
        alias: "available-model",
        model: "available-model",
        modelType: "llm",
        protocol: "openai",
        isAvailable: true,
      },
      {
        alias: "disabled-model",
        model: "disabled-model",
        modelType: "llm",
        protocol: "openai",
        isAvailable: false,
        unavailableReason: "Disabled by team policy",
      },
      {
        alias: "image-model",
        model: "image-model",
        modelType: "image",
        protocol: "openai",
        isAvailable: true,
      },
    ],
  });

  render(<RuntimeModelPicker provider="codex" value="" onChange={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "Default model" }));
  expect(await screen.findByRole("option", { name: /available-model.*openai.*available/i })).toBeEnabled();
  expect(screen.getByRole("option", { name: /disabled-model.*Disabled by team policy/i })).toBeDisabled();
  expect(screen.queryByRole("option", { name: /image-model/i })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Search models"), "disabled");
  expect(screen.queryByRole("option", { name: /available-model/i })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /disabled-model/i })).toBeInTheDocument();
});

it("localizes known model availability reasons in Chinese", async () => {
  vi.mocked(listProtocolFilteredRuntimeModelsAction).mockResolvedValue({
    configured: true,
    list: [
      {
        alias: "incompatible-model",
        model: "incompatible-model",
        modelType: "llm",
        protocol: "openai",
        isAvailable: false,
        unavailableReason: "Runtime protocol (anthropic) not supported",
      },
    ],
  });

  renderChinese(<RuntimeModelPicker provider="claude" value="" onChange={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "默认模型" }));
  expect(await screen.findByRole("option", { name: /不支持执行引擎协议（anthropic）/ })).toBeDisabled();
});

it("finishes loading when the latest request resolves after the provider changes", async () => {
  window.localStorage.clear();
  const resolveRequests: Array<(value: Awaited<ReturnType<typeof listProtocolFilteredRuntimeModelsAction>>) => void> = [];
  vi.mocked(listProtocolFilteredRuntimeModelsAction).mockClear();
  vi.mocked(listProtocolFilteredRuntimeModelsAction).mockImplementation(
    () => new Promise((resolve) => resolveRequests.push(resolve)),
  );

  const view = testingRender(
    <LanguageProvider initialLanguage="en">
      <RuntimeModelPicker provider="codex" value="openai_response" onChange={vi.fn()} />
    </LanguageProvider>,
  );

  await waitFor(() => {
    expect(listProtocolFilteredRuntimeModelsAction).toHaveBeenCalledTimes(1);
  });
  view.rerender(
    <LanguageProvider initialLanguage="en">
      <RuntimeModelPicker provider="claude" value="openai_response" onChange={vi.fn()} />
    </LanguageProvider>,
  );
  await waitFor(() => {
    expect(listProtocolFilteredRuntimeModelsAction).toHaveBeenCalledTimes(2);
  });
  await act(async () => {
    resolveRequests[resolveRequests.length - 1]?.({
      configured: true,
      list: [
        {
          alias: "openai_response",
          model: "openai_response",
          modelType: "llm",
          protocol: "openai",
          isAvailable: true,
        },
      ],
    });
  });

  expect((await screen.findAllByText("openai")).length).toBeGreaterThan(0);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Default model" })).toBeEnabled();
  });
});
