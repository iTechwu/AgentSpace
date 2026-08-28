import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { ChatModelCommandDialog, ChatModelSelector } from "@/features/chat/chat-model-selector";

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

  it("shows a generic empty state when no protocol-compatible model is available", async () => {
    mocks.getChatModelOverrideAction.mockResolvedValueOnce({
      routerSessionId: "router-session-1",
      agentName: "Atlas",
      provider: "codex",
    });
    mocks.listProtocolFilteredRuntimeModelsAction.mockResolvedValueOnce({
      configured: true,
      list: [
        {
          alias: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          model: "deepseek-v4-pro",
          modelType: "llm",
          protocol: "openai_response",
          isAvailable: false,
          unavailableReason: "Disabled by team policy",
        },
      ],
    });

    render(
      <LanguageProvider>
        <ChatModelCommandDialog contactId="Atlas" displayName="Atlas" onClose={vi.fn()} />
      </LanguageProvider>,
    );

    expect(await screen.findByText("暂无可用模型")).toBeInTheDocument();
    expect(screen.getByText("0 个可切换模型")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /DeepSeek V4 Pro.*已被团队策略禁用/ })).toBeDisabled();
    expect(mocks.setChatModelOverrideAction).not.toHaveBeenCalled();
  });

  it("searches a compact model catalog and avoids repeating identical aliases", async () => {
    const user = userEvent.setup();
    mocks.listProtocolFilteredRuntimeModelsAction.mockResolvedValueOnce({
      configured: true,
      list: [
        {
          alias: "seed-2.1-pro",
          displayName: "seed-2.1-pro",
          modelType: "llm",
          protocol: "anthropic",
          isAvailable: true,
        },
        {
          alias: "claude-opus-4.7-thinking",
          displayName: "Claude Opus 4.7 Thinking",
          modelType: "llm",
          protocol: "anthropic",
          isAvailable: true,
        },
      ],
    });
    mocks.getChatModelOverrideAction.mockResolvedValueOnce({
      routerSessionId: "router-session-1",
      agentName: "Claude",
      provider: "claude",
    });

    render(
      <LanguageProvider>
        <ChatModelCommandDialog contactId="Claude" displayName="Claude" onClose={vi.fn()} />
      </LanguageProvider>,
    );

    const search = await screen.findByRole("searchbox", { name: "搜索模型" });
    expect(screen.getAllByText("seed-2.1-pro")).toHaveLength(1);

    await user.type(search, "opus");

    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /seed-2.1-pro/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: /Claude Opus 4.7 Thinking/ })).toBeInTheDocument();
  });

  it("shows a terminal error instead of loading forever when session resolution fails", async () => {
    mocks.getChatModelOverrideAction.mockRejectedValueOnce(new Error("session unavailable"));

    render(
      <LanguageProvider>
        <ChatModelSelector canManage contactId="Atlas" displayName="Atlas" />
      </LanguageProvider>,
    );

    expect(await screen.findByText("模型加载失败")).toBeInTheDocument();
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
  });

  it("labels a bound runtime without an explicit model as inheriting the runtime default", async () => {
    mocks.getChatModelOverrideAction.mockResolvedValueOnce({
      routerSessionId: "router-session-1",
      agentName: "Atlas",
      provider: "codex",
    });

    render(
      <LanguageProvider>
        <ChatModelSelector canManage contactId="Atlas" displayName="Atlas" />
      </LanguageProvider>,
    );

    expect(await screen.findByText("Atlas（Runtime 默认）")).toBeInTheDocument();
    expect(screen.queryByText("Atlas（未配置）")).not.toBeInTheDocument();
  });
});
