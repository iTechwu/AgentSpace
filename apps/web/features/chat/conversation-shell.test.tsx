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
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
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

  it("shows and clears the no-mention warning as the mention attempt changes", async () => {
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

    const warning = "当前没有可 @ 的成员或 AI员工。";
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "插入 @ 提及" }));
    expect(screen.getByRole("alert")).toHaveTextContent(warning);

    const composer = screen.getByRole("textbox");
    expect(composer).toHaveValue("@");
    await user.type(composer, "其他内容");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "@");
    expect(screen.getByRole("alert")).toHaveTextContent(warning);

    await user.keyboard("{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(composer, "@");
    expect(screen.getByRole("alert")).toHaveTextContent(warning);

    await user.type(composer, " ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "@");
    expect(screen.getByRole("alert")).toHaveTextContent(warning);

    await user.type(composer, "任务");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the active agent reply after later execution updates", () => {
    render(
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[]}
          listCount={0}
          listKicker="Direct"
          listTitle="Direct"
          messages={[
            {
              id: "request",
              speaker: "techwu",
              role: "human",
              content: "请处理这个任务",
              timestamp: "10:00",
              status: "completed",
            },
            {
              id: "thinking",
              speaker: "Atlas",
              role: "agent",
              content: "正在分析任务",
              timestamp: "10:01",
              status: "pending",
              code: "agent.pending",
            },
            {
              id: "environment-ready",
              speaker: "Atlas",
              role: "agent",
              content: "正在准备执行环境",
              timestamp: "10:02",
              status: "completed",
              kind: "process",
              processType: "status",
            },
            {
              id: "tool-complete",
              speaker: "Atlas",
              role: "agent",
              content: "工具已完成",
              timestamp: "10:03",
              status: "completed",
              kind: "process",
              processType: "tool_result",
              tool: "exec_command",
            },
            {
              id: "tool-running",
              speaker: "Atlas",
              role: "agent",
              content: "正在调用工具",
              timestamp: "10:04",
              status: "pending",
              kind: "process",
              processType: "tool_use",
              tool: "exec_command",
            },
          ]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{
            title: "Direct chat",
            subtitle: "Agent",
            avatar: "A",
          }}
          selectedItemId="agent:atlas"
        />
      </LanguageProvider>,
    );

    const messageIds = Array.from(document.querySelectorAll("[data-conversation-message-id]")).map(
      (element) => element.getAttribute("data-conversation-message-id"),
    );

    expect(messageIds).toEqual(["request", "environment-ready", "tool-complete", "tool-running", "thinking"]);
    expect(screen.getAllByText("思考中")).toHaveLength(2);
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

  it("keeps the reading position and offers a return-to-latest action when new content arrives", async () => {
    const user = userEvent.setup();
    const createShell = (messages: Array<{
      id: string;
      speaker: string;
      role: "human" | "agent";
      content: string;
      timestamp: string;
      status: "completed";
    }>) => (
      <LanguageProvider>
        <ConversationShell
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "tour-visit", title: "tour visit", subtitle: "channel", meta: "meta", avatar: "#" }]}
          listCount={1}
          listKicker="Channels"
          listTitle="Channels"
          messages={messages}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "tour visit", subtitle: "channel", avatar: "#" }}
          selectedItemId="tour-visit"
        />
      </LanguageProvider>
    );
    const initialMessages = [{
      id: "message-1",
      speaker: "Atlas",
      role: "agent" as const,
      content: "first",
      timestamp: "10:00",
      status: "completed" as const,
    }];
    const { rerender } = render(createShell(initialMessages));
    const thread = document.querySelector<HTMLDivElement>(".contacts-chat-thread");

    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 300 });
    thread!.scrollTop = 280;
    fireEvent.scroll(thread!);

    rerender(createShell([
      ...initialMessages,
      {
        id: "message-2",
        speaker: "Atlas",
        role: "agent",
        content: "second",
        timestamp: "10:01",
        status: "completed",
      },
    ]));

    expect(thread?.scrollTop).toBe(280);
    const latestButton = screen.getByRole("button", { name: "回到最新消息" });
    expect(latestButton).toHaveTextContent("有新消息");

    await user.click(latestButton);

    expect(thread?.scrollTop).toBe(1200);
    expect(screen.queryByRole("button", { name: "回到最新消息" })).not.toBeInTheDocument();
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

  it("shows the submitted message immediately while delivery is pending", async () => {
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
    expect(screen.getByText("继续检查发送体验")).toBeInTheDocument();
    expect(screen.getByLabelText("正在发送")).toBeInTheDocument();

    await act(async () => {
      resolveSubmit?.();
    });
    expect(await screen.findByLabelText("已发送")).toHaveAttribute("role", "status");
  });

  it("shows submitted file metadata immediately while upload is pending", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    }));

    const { container } = render(
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

    const fileInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    expect(fileInput).toBeTruthy();
    await user.upload(fileInput!, new File(["brief"], "brief.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("brief.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览 brief.txt" })).toBeInTheDocument();

    await act(async () => {
      resolveSubmit?.();
    });
  });

  it("scrolls a submitted message into view when supplementary content follows the message list", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    }));
    const scrollIntoView = vi.fn(function scrollSubmittedMessageIntoView(this: HTMLElement) {
      const thread = this.closest<HTMLDivElement>(".contacts-chat-thread");
      if (thread) thread.scrollTop = 200;
    });
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const { rerender } = render(
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
            threadAfterMessages={<div>Task details</div>}
          />
        </LanguageProvider>,
      );

      await user.type(screen.getByRole("textbox"), "滚动到刚发送的消息");
      const thread = document.querySelector<HTMLDivElement>(".contacts-chat-thread");
      Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(thread, "clientHeight", { configurable: true, value: 300 });
      await user.click(screen.getByRole("button", { name: "发送消息" }));

      expect(await screen.findByText("滚动到刚发送的消息")).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
      const initialScrollCalls = scrollIntoView.mock.calls.length;
      rerender(
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
            messages={[{
              id: "server-message-1",
              speaker: "techwu",
              role: "human",
              content: "滚动到刚发送的消息",
              timestamp: new Date().toISOString(),
              status: "completed",
            }]}
            onSelectItem={vi.fn()}
            onSubmit={onSubmit}
            placeholder="Send a message"
            selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
            selectedItemId="direct-atlas"
            threadAfterMessages={<div>Task details</div>}
          />
        </LanguageProvider>,
      );
      await waitFor(() => expect(scrollIntoView.mock.calls.length).toBeGreaterThan(initialScrollCalls));
      await waitFor(() => expect(screen.getAllByText("滚动到刚发送的消息")).toHaveLength(1));
      expect(thread?.scrollTop).toBe(200);
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      await act(async () => {
        resolveSubmit?.();
      });
      expect(await screen.findByLabelText("已发送")).toBeInTheDocument();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: previousScrollIntoView,
      });
    }
  });

  it("places timestamped supplementary items at their chronological position in the thread", () => {
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
          messages={[
            {
              id: "message-before",
              speaker: "techwu",
              role: "human",
              content: "开始生成视频",
              timestamp: "10:00",
              sortTimestamp: "2026-08-20T10:00:00.000Z",
              status: "completed",
            },
            {
              id: "message-after",
              speaker: "Atlas",
              role: "agent",
              content: "视频处理结果",
              timestamp: "10:10",
              sortTimestamp: "2026-08-20T10:10:00.000Z",
              status: "completed",
            },
          ]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
          threadTimelineItems={[
            {
              id: "video-job",
              timestamp: "2026-08-20T10:05:00.000Z",
              content: <div>视频任务进度</div>,
            },
          ]}
        />
      </LanguageProvider>,
    );

    const threadText = document.querySelector(".contacts-chat-thread")?.textContent ?? "";
    expect(threadText.indexOf("开始生成视频")).toBeLessThan(threadText.indexOf("视频任务进度"));
    expect(threadText.indexOf("视频任务进度")).toBeLessThan(threadText.indexOf("视频处理结果"));
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
    expect(document.querySelector("[data-conversation-message-id]")).toHaveTextContent("保留这条失败消息");
    expect(screen.getByLabelText("发送失败")).toBeInTheDocument();
  });

  it("replaces the optimistic message when the server copy arrives", async () => {
    const user = userEvent.setup();
    const commonProps = {
      currentUserDisplayName: "techwu",
      emptyListBody: "empty",
      emptyListTitle: "empty",
      emptyThreadBody: "empty",
      emptyThreadTitle: "empty",
      items: [{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }],
      listCount: 1,
      listKicker: "Messages",
      listTitle: "Messages",
      onSelectItem: vi.fn(),
      onSubmit: vi.fn(async () => {}),
      placeholder: "Send a message",
      selectedHeader: { title: "Atlas", subtitle: "Agent", avatar: "A" },
      selectedItemId: "direct-atlas",
    };
    const { rerender } = render(
      <LanguageProvider>
        <ConversationShell {...commonProps} messages={[]} />
      </LanguageProvider>,
    );

    await user.type(screen.getByRole("textbox"), "只显示一次");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByLabelText("已发送")).toBeInTheDocument();

    rerender(
      <LanguageProvider>
        <ConversationShell
          {...commonProps}
          messages={[{
            id: "server-message-1",
            speaker: "techwu",
            role: "human",
            content: "只显示一次",
            timestamp: new Date().toISOString(),
            status: "completed",
          }]}
        />
      </LanguageProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("只显示一次")).toHaveLength(1));
    expect(screen.getByLabelText("已发送")).toHaveAttribute("role", "img");
  });

  it("does not reconcile an optimistic message against another conversation", async () => {
    const user = userEvent.setup();
    const commonProps = {
      currentUserDisplayName: "techwu",
      emptyListBody: "empty",
      emptyListTitle: "empty",
      emptyThreadBody: "empty",
      emptyThreadTitle: "empty",
      items: [
        { id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" },
        { id: "direct-nova", title: "Nova", subtitle: "Agent", meta: "meta", avatar: "N" },
      ],
      listCount: 2,
      listKicker: "Messages",
      listTitle: "Messages",
      onSelectItem: vi.fn(),
      onSubmit: vi.fn(async () => {}),
      placeholder: "Send a message",
    };
    const { rerender } = render(
      <LanguageProvider>
        <ConversationShell
          {...commonProps}
          messages={[]}
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    await user.type(screen.getByRole("textbox"), "相同内容");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByLabelText("已发送")).toBeInTheDocument();

    rerender(
      <LanguageProvider>
        <ConversationShell
          {...commonProps}
          messages={[{
            id: "nova-server-message",
            speaker: "techwu",
            role: "human",
            content: "相同内容",
            timestamp: new Date().toISOString(),
            status: "completed",
          }]}
          selectedHeader={{ title: "Nova", subtitle: "Agent", avatar: "N" }}
          selectedItemId="direct-nova"
        />
      </LanguageProvider>,
    );
    rerender(
      <LanguageProvider>
        <ConversationShell
          {...commonProps}
          messages={[]}
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("相同内容")).toBeInTheDocument();
    expect(screen.getByLabelText("已发送")).toBeInTheDocument();
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
          executionStatus="正在调用工具"
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

    expect(screen.getByRole("status")).toHaveTextContent("正在调用工具");

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
    expect(await screen.findByText("当前运行时会话会在下一条消息中自动续接。")).toBeInTheDocument();
  });

  it("opens conversation history when /resume is submitted", async () => {
    const user = userEvent.setup();
    const onOpenConversationHistory = vi.fn();
    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "Atlas", employeeLabel: "Atlas", provider: "codex" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-atlas", title: "Atlas", subtitle: "Agent", meta: "meta", avatar: "A" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onOpenConversationHistory={onOpenConversationHistory}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          placeholder="Send a message"
          selectedHeader={{ title: "Atlas", subtitle: "Agent", avatar: "A" }}
          selectedItemId="direct-atlas"
        />
      </LanguageProvider>,
    );

    await user.type(screen.getByRole("textbox"), "/resume{Enter}");
    expect(onOpenConversationHistory).toHaveBeenCalledTimes(1);
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
    expect(await screen.findByText("当前运行时会话会在下一条消息中自动续接。")).toBeInTheDocument();
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

    const pickerTrigger = screen.getByRole("button", { name: "打开附件与快捷内容菜单" });
    await user.click(pickerTrigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "引用成员、文件或技能" })).toHaveFocus();
    });
    expect(screen.getByRole("menuitem", { name: "本地文件" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "本地文件夹" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "图片/视频" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(pickerTrigger).toHaveFocus();
  });

  it("adds pasted images and documents to the composer for preview, removal, and sending", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (input: {
      content: string;
      files: File[];
      replyToMessageId?: string;
      referenceAttachmentIds?: string[];
      referenceSkillIds?: string[];
    }) => {
      void input;
    });
    const screenshot = new File(["image-bytes"], "clipboard-shot.png", { type: "image/png" });
    const document = new File(["pdf-bytes"], "clipboard-brief.pdf", { type: "application/pdf" });

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

    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [screenshot, document] },
    });

    expect(screen.getByRole("button", { name: "预览 clipboard-shot.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览 clipboard-brief.pdf" })).toBeInTheDocument();
    expect(screen.getByAltText("clipboard-shot.png")).toHaveAttribute("src", "blob:clipboard-shot.png");

    await user.click(screen.getByRole("button", { name: "预览 clipboard-brief.pdf" }));
    expect(screen.getByRole("dialog", { name: "预览 clipboard-brief.pdf" })).toBeInTheDocument();
    expect(screen.getByTitle("clipboard-brief.pdf")).toHaveAttribute("src", "blob:clipboard-brief.pdf");
    await user.click(screen.getByRole("button", { name: "关闭预览" }));

    await user.click(screen.getByRole("button", { name: "移除 clipboard-brief.pdf" }));
    expect(screen.queryByRole("button", { name: "预览 clipboard-brief.pdf" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0].files).toEqual([screenshot]);
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

    const policyTrigger = screen.getByRole("button", { name: /^Auto/ });
    await user.click(policyTrigger);
    expect(screen.getByRole("option", { name: /Manual/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Edit automatically/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Plan/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Auto/ })).toBeInTheDocument();
    await user.tab();
    expect(screen.getAllByRole("option")[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "执行权限" })).not.toBeInTheDocument();
    expect(policyTrigger).toHaveFocus();

    await user.click(policyTrigger);
    await user.click(screen.getByRole("option", { name: /^Plan/ }));

    await waitFor(() => expect(onUpdateExecutionPolicy).toHaveBeenCalledWith("Atlas", { claudePermissionMode: "plan" }));
    expect(policyTrigger).toHaveFocus();
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

    const policyTrigger = screen.getByRole("button", { name: /完全访问/ });
    await user.click(policyTrigger);
    expect(screen.getByRole("option", { name: /请求批准/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /帮我审批/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /完全访问/ }));

    await waitFor(() => expect(onUpdateExecutionPolicy).toHaveBeenCalledWith("Codex", {
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
    }));
    expect(screen.getByRole("button", { name: /完全访问/ })).toBeInTheDocument();
  });

  it("keeps DeepSeek Harness permissions on the runtime default", async () => {
    const user = userEvent.setup();
    const onUpdateExecutionPolicy = vi.fn(async () => {});

    render(
      <LanguageProvider>
        <ConversationShell
          composerRuntime={{ employeeId: "DeepSeek", employeeLabel: "DeepSeek", provider: "deepseek-harness" }}
          emptyListBody="empty"
          emptyListTitle="empty"
          emptyThreadBody="empty"
          emptyThreadTitle="empty"
          items={[{ id: "direct-deepseek", title: "DeepSeek", subtitle: "Agent", meta: "meta", avatar: "D" }]}
          listCount={1}
          listKicker="Messages"
          listTitle="Messages"
          messages={[]}
          onSelectItem={vi.fn()}
          onSubmit={vi.fn(async () => {})}
          onUpdateExecutionPolicy={onUpdateExecutionPolicy}
          placeholder="Send a message"
          selectedHeader={{ title: "DeepSeek", subtitle: "Agent", avatar: "D" }}
          selectedItemId="direct-deepseek"
        />
      </LanguageProvider>,
    );

    const policyTrigger = screen.getByRole("button", { name: /Runtime 默认/ });
    await user.click(policyTrigger);
    expect(screen.getByText(/DeepSeek Harness.*执行权限/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Runtime 默认/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /完全访问/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /帮我审批/ })).not.toBeInTheDocument();
  });
});
