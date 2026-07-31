import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { ChatModelCommandDialog } from "@/features/chat/chat-model-selector";

const mocks = vi.hoisted(() => ({
  getChatModelOverrideAction: vi.fn(),
  setChatModelOverrideAction: vi.fn(),
  listProtocolFilteredRuntimeModelsAction: vi.fn(),
}));

vi.mock("@/features/channels/actions", () => ({
  getChatModelOverrideAction: mocks.getChatModelOverrideAction,
  setChatModelOverrideAction: mocks.setChatModelOverrideAction,
}));

vi.mock("@/features/runtimes/actions", () => ({
  listProtocolFilteredRuntimeModelsAction: mocks.listProtocolFilteredRuntimeModelsAction,
}));

describe("ChatModelCommandDialog", () => {
  beforeEach(() => {
    mocks.getChatModelOverrideAction.mockReset().mockResolvedValue({
      routerSessionId: "router-session-1",
      agentName: "Atlas",
      provider: "codex",
      sessionOverride: { modelId: "gpt-5.6-sol", source: "manual" },
    });
    mocks.listProtocolFilteredRuntimeModelsAction.mockReset().mockResolvedValue({
      configured: true,
      list: [
        { alias: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isAvailable: true },
        { alias: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isAvailable: true },
      ],
    });
    mocks.setChatModelOverrideAction.mockReset().mockResolvedValue({ ok: true });
  });

  it("switches the conversation model without creating a chat message", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChanged = vi.fn();

    render(
      <LanguageProvider>
        <ChatModelCommandDialog
          contactId="Atlas"
          displayName="Atlas"
          onChanged={onChanged}
          onClose={onClose}
        />
      </LanguageProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "切换模型" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /GPT-5.6 Sol/ })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("option", { name: /GPT-5.6 Terra/ }));

    await waitFor(() => expect(mocks.setChatModelOverrideAction).toHaveBeenCalledWith({
      contactId: "Atlas",
      channelName: undefined,
      content: undefined,
      modelId: "gpt-5.6-terra",
    }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
