import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationShell } from "@/features/chat/conversation-shell";
import { LanguageProvider } from "@/features/i18n/language-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("ConversationShell", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    window.sessionStorage.clear();
  });

  it("prepends an agent mention when replying to an agent message in channel chat", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "tour-visit",
              title: "tour visit",
              subtitle: "1 humans / 1 agents",
              meta: "meta",
              avatar: "#",
            },
          ]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          mentionCandidates={[
            {
              id: "techwu's assistant",
              label: "techwu's assistant",
              subtitle: "Assistant",
              inChannel: true,
            },
          ]}
          messages={[
            {
              id: "message-1",
              speaker: "techwu's assistant",
              role: "agent",
              content: "我来处理一下。",
              timestamp: "10:00",
              status: "completed",
            },
          ]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "tour visit",
            subtitle: "1 humans / 1 agents",
            avatar: "#",
          }}
          selectedItemId="tour-visit"
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "回复" }));
    expect(screen.getByRole("textbox")).toHaveValue("@techwu's assistant ");
  });

  it("switches between list and thread on compact layouts without affecting selection", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    const onSelectItem = vi.fn();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "tour-visit",
              title: "tour visit",
              subtitle: "1 humans / 1 agents",
              meta: "meta",
              avatar: "#",
            },
          ]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          messages={[
            {
              id: "message-1",
              speaker: "techwu",
              role: "human",
              content: "hello",
              timestamp: "10:00",
              status: "completed",
            },
          ]}
          onSelectItem={onSelectItem}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "tour visit",
            subtitle: "1 humans / 1 agents",
            avatar: "#",
          }}
          selectedItemId="tour-visit"
        />
      </LanguageProvider>,
    );

    expect(await screen.findByRole("button", { name: "返回列表" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /meta/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回列表" }));
    expect(screen.getByRole("button", { name: /tour visit/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /tour visit/i }));
    expect(onSelectItem).toHaveBeenCalledWith("tour-visit");
    expect(await screen.findByRole("button", { name: "返回列表" })).toBeInTheDocument();
  });

  it("labels only the current user's human messages as own", () => {
    render(
      <LanguageProvider>
        <ConversationShell
          currentUserDisplayName="techwu"
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "human:user-mina",
              title: "Mina",
              subtitle: "Human",
              meta: "meta",
              avatar: "M",
            },
          ]}
          listCount={1}
          listKicker="Direct"
          listTitle="Direct"
          messages={[
            {
              id: "message-1",
              speaker: "techwu",
              role: "human",
              content: "hi",
              timestamp: "10:00",
              status: "completed",
            },
            {
              id: "message-2",
              speaker: "Mina",
              role: "human",
              content: "?",
              timestamp: "10:01",
              status: "completed",
            },
          ]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "Direct chat",
            subtitle: "Human",
            avatar: "M",
          }}
          selectedItemId="human:user-mina"
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("你")).toBeInTheDocument();
    expect(screen.getAllByText("Mina").length).toBeGreaterThan(0);
  });

  it("restores a saved thread scroll anchor after the shell remounts", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      speaker: index % 2 === 0 ? "techwu" : "Atlas",
      role: (index % 2 === 0 ? "human" : "agent") as "human" | "agent",
      content: `message ${index}`,
      timestamp: `10:${String(index).padStart(2, "0")}`,
      status: "completed" as const,
    }));
    const shell = (
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "tour-visit",
              title: "tour visit",
              subtitle: "1 humans / 1 agents",
              meta: "meta",
              avatar: "#",
            },
          ]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          messages={messages}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          scrollAnchorStorageKey="workspace-1:im:scroll-anchors"
          selectedHeader={{
            title: "tour visit",
            subtitle: "1 humans / 1 agents",
            avatar: "#",
          }}
          selectedItemId="tour-visit"
        />
      </LanguageProvider>
    );
    const { unmount } = render(shell);
    const thread = document.querySelector<HTMLDivElement>(".contacts-chat-thread");

    expect(thread).not.toBeNull();
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 300 });
    thread!.scrollTop = 360;
    fireEvent.scroll(thread!);
    unmount();

    render(shell);

    expect(document.querySelector<HTMLDivElement>(".contacts-chat-thread")?.scrollTop).toBe(360);
  });

  it("renders the supplementary panel as a dismissible mobile sheet on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    const onCloseSupplementaryPanel = vi.fn();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "tour-visit",
              title: "tour visit",
              subtitle: "1 humans / 1 agents",
              meta: "meta",
              avatar: "#",
            },
          ]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          messages={[
            {
              id: "message-1",
              speaker: "techwu",
              role: "human",
              content: "hello",
              timestamp: "10:00",
              status: "completed",
            },
          ]}
          onCloseSupplementaryPanel={onCloseSupplementaryPanel}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "tour visit",
            subtitle: "1 humans / 1 agents",
            avatar: "#",
          }}
          selectedItemId="tour-visit"
          supplementaryPanel={<div>Docs content</div>}
          supplementaryPanelTitle="Docs & files"
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Docs & files" })).toBeInTheDocument();
    expect(screen.getByText("Docs content")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /关闭面板|Close panel/i })[1]);
    expect(onCloseSupplementaryPanel).toHaveBeenCalledTimes(1);
  });

  it("renders the supplementary panel as a desktop side pane on wide layouts", async () => {
    const user = userEvent.setup();
    const onCloseSupplementaryPanel = vi.fn();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[
            {
              id: "tour-visit",
              title: "tour visit",
              subtitle: "1 humans / 1 agents",
              meta: "meta",
              avatar: "#",
            },
          ]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          messages={[
            {
              id: "message-1",
              speaker: "techwu",
              role: "human",
              content: "hello",
              timestamp: "10:00",
              status: "completed",
            },
          ]}
          onCloseSupplementaryPanel={onCloseSupplementaryPanel}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "tour visit",
            subtitle: "1 humans / 1 agents",
            avatar: "#",
          }}
          selectedItemId="tour-visit"
          supplementaryPanel={<div>Docs content</div>}
          supplementaryPanelTitle="Docs & files"
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("Docs & files")).toBeInTheDocument();
    expect(screen.getByText("Docs content")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /关闭面板|Close panel/i }));
    expect(onCloseSupplementaryPanel).toHaveBeenCalledTimes(1);
  });

  it("clears the composer immediately while a message submission is pending", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    }));

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={onSubmit}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "继续检查发送体验");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSubmit).toHaveBeenCalledWith({
      content: "继续检查发送体验",
      files: [],
      replyToMessageId: undefined,
    });
    expect(composer).toHaveValue("");

    await act(async () => {
      resolveSubmit?.();
    });
  });

  it("restores the submitted draft when an optimistic submission fails", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {
            throw new Error("发送失败");
          })}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "保留这条失败消息");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByText("发送失败")).toBeInTheDocument());
    expect(composer).toHaveValue("保留这条失败消息");
  });

  it("switches the composer between stop and queue actions while an agent is running", async () => {
    const user = userEvent.setup();
    const onStopActiveTask = vi.fn(async () => {});
    const onSubmit = vi.fn(async () => {});

    render(
      <LanguageProvider>
        <ConversationShell
          draftStorageKey="workspace-1:im:composer"
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          isAgentRunning
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onStopActiveTask={onStopActiveTask}
          onSubmit={onSubmit}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "停止执行" }));
    expect(onStopActiveTask).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox"), "继续检查类型错误");
    await user.click(screen.getByRole("button", { name: "加入消息队列" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "消息队列" })).toHaveTextContent("继续检查类型错误");
    expect(window.sessionStorage.getItem("workspace-1:im:composer:queue:direct-atlas")).toContain("继续检查类型错误");

    await user.click(screen.getByRole("button", { name: /立即引导：继续检查类型错误/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      content: "继续检查类型错误",
      files: [],
      replyToMessageId: undefined,
    }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "消息队列" })).not.toBeInTheDocument());
  });

  it("automatically submits the first queued message when the active run finishes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const commonProps = {
      draftStorageKey: "workspace-1:im:composer",
      emptyListBody: "empty",
      emptyListTitle: "empty",
      emptyThreadBody: "empty",
      emptyThreadTitle: "empty",
      items: [{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }],
      listCount: 1,
      listKicker: "Messages",
      listTitle: "Messages",
      messages: [],
      onSelectItem: vi.fn(),
      onSubmit,
      placeholder: "Send a message",
      selectedHeader: { title: "Atlas", subtitle: "Agent", avatar: "A" },
      selectedItemId: "direct-atlas",
    };
    const { rerender } = render(
      <LanguageProvider>
        <ConversationShell {...commonProps} isAgentRunning />
      </LanguageProvider>,
    );

    await user.type(screen.getByRole("textbox"), "下一步检查");
    await user.click(screen.getByRole("button", { name: "加入消息队列" }));
    rerender(
      <LanguageProvider>
        <ConversationShell {...commonProps} isAgentRunning={false} />
      </LanguageProvider>,
    );

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      content: "下一步检查",
      files: [],
      replyToMessageId: undefined,
    }));
  });

  it("adds file and skill references without inserting invalid member mentions", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          mentionCandidates={[
            { id: "file:quarterly", sourceId: "att-quarterly", label: "quarterly.csv", subtitle: "text/csv", inChannel: true, kind: "file" },
            { id: "skill:finance", sourceId: "skill-finance", label: "Finance review", subtitle: "Review financial data", inChannel: true, kind: "skill" },
          ]}
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={onSubmit}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "@");
    await user.click(screen.getByRole("option", { name: /quarterly\.csv/ }));
    expect(composer).toHaveValue("");
    expect(screen.getByText("quarterly.csv")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "插入 @ 提及" }));
    await user.click(screen.getByRole("option", { name: /Finance review/ }));
    await user.type(composer, "analyze");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      content: "analyze",
      files: [],
      replyToMessageId: undefined,
      referenceAttachmentIds: ["att-quarterly"],
      referenceSkillIds: ["skill-finance"],
    }));
  });

  it("shows runtime-aware slash commands and supports keyboard selection", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Atlas", employeeLabel: "Atlas", provider: "claude" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "/");
    expect(screen.getByRole("listbox", { name: "快捷指令" })).toBeInTheDocument();
    expect(screen.getByText("/model")).toBeInTheDocument();
    expect(screen.getByText("/resume")).toBeInTheDocument();
    expect(screen.getByText("/plan")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(composer).toHaveValue("");
    expect(screen.getByText("当前运行时会话会在下一条消息中自动续接。")).toBeInTheDocument();
  });

  it("handles /model as a local command instead of sending it as message context", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const onOpenModelSelector = vi.fn();

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Atlas", employeeLabel: "Atlas", provider: "claude" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={onSubmit}
          onOpenModelSelector={onOpenModelSelector}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "/model");
    await user.keyboard("{Enter}{Enter}");

    expect(composer).toHaveValue("");
    expect(onOpenModelSelector).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(composer, "/model");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(composer).toHaveValue("");
    expect(onOpenModelSelector).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("handles resume locally in a group conversation", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Atlas", employeeLabel: "Atlas", provider: "claude", requiresMentionForCommands: true }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "general", title: "General", subtitle: "Group", meta: "meta", avatar: "G" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "General", subtitle: "Group", avatar: "G" }}
          selectedItemId="general"
        />
      </LanguageProvider>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "/res");
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("");
    expect(screen.getByText("当前运行时会话会在下一条消息中自动续接。")).toBeInTheDocument();
  });

  it("opens the unified references and attachments menu from the plus button", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开附件与快捷内容菜单" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "引用成员、文件或技能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "本地文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "本地文件夹" })).toBeInTheDocument();
  });

  it("offers all Claude Code permission modes and saves the selected mode", async () => {
    const user = userEvent.setup();
    const onUpdateExecutionPolicy = vi.fn(async () => {});

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Atlas", employeeLabel: "Atlas", provider: "claude" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          onUpdateExecutionPolicy={onUpdateExecutionPolicy}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Runtime 默认/ }));
    expect(screen.getByRole("option", { name: /Manual/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Edit automatically/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Plan/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Auto/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /^Plan/ }));

    await waitFor(() => expect(onUpdateExecutionPolicy).toHaveBeenCalledWith("Atlas", { claudePermissionMode: "plan" }));
  });

  it("offers Codex approval policies and marks full access as the selected policy", async () => {
    const user = userEvent.setup();
    const onUpdateExecutionPolicy = vi.fn(async () => {});

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Codex", employeeLabel: "Codex", provider: "codex" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-codex", title: "Codex", subtitle: "Agent", meta: "meta", avatar: "C" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          onUpdateExecutionPolicy={onUpdateExecutionPolicy}
          placeholder="Send a message"
          selectedHeader={{ title: "Codex", subtitle: "Agent", avatar: "C" }}
          selectedItemId="direct-codex"
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Runtime 默认/ }));
    expect(screen.getByRole("option", { name: /请求批准/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /帮我审批/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /完全访问/ }));

    await waitFor(() => expect(onUpdateExecutionPolicy).toHaveBeenCalledWith("Codex", {
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
    }));
    expect(screen.getByRole("button", { name: /完全访问/ })).toBeInTheDocument();
  });
});
