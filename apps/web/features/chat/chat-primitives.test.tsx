import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAttachmentRow, ConversationMessageBubble, TaskExecutionTimeline } from "@/features/chat/chat-primitives";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { MessageAttachment } from "@/shared/types/workspace";

function createAttachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    id: "att-1",
    fileName: "preview.png",
    mediaType: "image/png",
    sizeBytes: 2048,
    kind: "image",
    storedPath: "tos://test-bucket/workspaces/default/attachments/att-1/preview.png",
    storageProvider: "tos",
    storageKey: "workspaces/default/attachments/att-1/preview.png",
    ...overrides,
  };
}

describe("TaskExecutionTimeline", () => {
  it("keeps stable rows collapsed until the user expands them", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <LanguageProvider initialLanguage="zh">
        <TaskExecutionTimeline
          running
          items={[
            {
              id: "thinking-1",
              kind: "thinking",
              title: "思考过程",
              detail: "第一行\n最后一行",
              status: "running",
            },
          ]}
        />
      </LanguageProvider>,
    );

    const summary = screen.getByText("思考过程").closest("summary");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary?.firstElementChild).toHaveClass("execution-timeline__chevron");
    expect(screen.getByText("最后一行")).toBeInTheDocument();
    expect(screen.queryByText("第一行\n最后一行")).not.toBeInTheDocument();

    await user.click(summary!);

    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === "第一行\n最后一行"),
    ).toBeInTheDocument();

    rerender(
      <LanguageProvider initialLanguage="zh">
        <TaskExecutionTimeline
          running
          items={[{
            id: "thinking-1",
            kind: "thinking",
            title: "思考过程",
            detail: "第一行\n最后一行\n新增一行",
            status: "running",
          }]}
        />
      </LanguageProvider>,
    );

    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent?.endsWith("新增一行") === true),
    ).toBeInTheDocument();
  });

  it("renders tool input and progressively reveals long output only after expansion", async () => {
    const user = userEvent.setup();
    const longOutput = "x".repeat(17_000);
    const { container } = render(
      <LanguageProvider initialLanguage="zh">
        <TaskExecutionTimeline
          items={[
            {
              id: "tool-1",
              kind: "tool",
              title: "exec_command",
              subtitle: "pnpm test",
              inputDetail: "pnpm test",
              outputDetail: longOutput,
              detail: `pnpm test\n\n${longOutput}`,
              status: "done",
            },
          ]}
        />
      </LanguageProvider>,
    );

    expect(container.querySelector(".execution-timeline__io")).not.toBeInTheDocument();
    await user.click(screen.getByText("exec_command").closest("summary")!);

    expect(screen.getByText("IN")).toBeInTheDocument();
    expect(screen.getByText("OUT")).toBeInTheDocument();
    const output = container.querySelector(".execution-timeline__detail-output");
    expect(output?.textContent).toHaveLength(16_000);
    expect(screen.getByRole("button", { name: "继续加载输出" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续加载输出" }));

    expect(output?.textContent).toHaveLength(17_000);
    expect(screen.queryByRole("button", { name: "继续加载输出" })).not.toBeInTheDocument();
  });
});

describe("ChatAttachmentRow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading placeholder until an image preview finishes loading", () => {
    const { container } = render(
      <ChatAttachmentRow
        attachments={[createAttachment({ id: "att-image", fileName: "preview.png" })]}
      />,
    );

    expect(container.querySelector(".chat-attachment-image__loading")).toBeInTheDocument();

    fireEvent.load(screen.getByAltText("preview.png"));

    expect(container.querySelector(".chat-attachment-image__loading")).not.toBeInTheDocument();
    expect(screen.getByAltText("preview.png")).toHaveClass("chat-attachment-image__img--ready");
  });

  it("falls back to a file card when an image preview fails", () => {
    render(
      <ChatAttachmentRow
        attachments={[createAttachment({ id: "att-broken", fileName: "broken-preview.png" })]}
      />,
    );

    fireEvent.error(screen.getByAltText("broken-preview.png"));

    expect(screen.queryByAltText("broken-preview.png")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预览 broken-preview\.png/i })).toHaveClass("chat-attachment-file");
    expect(screen.getByText("IMG")).toBeInTheDocument();
  });

  it("opens sent images in an in-app preview with download and close actions", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <ChatAttachmentRow
          attachments={[createAttachment({ id: "att-image", fileName: "preview.png" })]}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "预览 preview.png" }));

    expect(screen.getByRole("dialog", { name: "预览 preview.png" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 preview.png" })).toHaveAttribute(
      "href",
      "/api/attachments/att-image",
    );
    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("dialog", { name: "预览 preview.png" })).not.toBeInTheDocument();
  });

  it("renders Markdown attachments as UTF-8 Markdown instead of an iframe", async () => {
    const user = userEvent.setup();
    const markdown = "# 分镜稿\n\n- **镜头一**：开场\n\n| 时长 | 画面 |\n| --- | --- |\n| 3 秒 | 山谷 |";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode(markdown), { status: 200 })));

    render(
      <LanguageProvider initialLanguage="zh">
        <ChatAttachmentRow
          attachments={[
            createAttachment({
              id: "att-markdown",
              fileName: "分镜稿.md",
              mediaType: "text/markdown",
              kind: "file",
            }),
          ]}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "预览 分镜稿.md" }));
    expect(await screen.findByRole("heading", { name: "分镜稿" })).toBeInTheDocument();
    expect(screen.getByText("镜头一").tagName).toBe("STRONG");
    expect(screen.getByText("山谷")).toBeInTheDocument();
    expect(screen.queryByTitle("分镜稿.md")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/attachments/att-markdown?preview=1");
  });
});

describe("ConversationMessageBubble", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("translates the system speaker label in English", () => {
    render(
      <LanguageProvider initialLanguage="en">
        <ConversationMessageBubble
          message={{
            id: "message-system",
            speaker: "系统提示",
            role: "agent",
            content: "A background update completed.",
            timestamp: "10:00",
            status: "completed",
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "View System Notice details" })).toBeInTheDocument();
    expect(screen.getAllByText("System Notice")).toHaveLength(2);
    expect(screen.queryByText("系统提示")).not.toBeInTheDocument();
  });

  it("keeps the sender and timestamp out of the default message reading flow", () => {
    const { container } = render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          isOwn
          message={{
            id: "message-own",
            speaker: "吴敏",
            role: "human",
            content: "你好",
            timestamp: "10:06",
            status: "completed",
          }}
        />
      </LanguageProvider>,
    );

    const bubble = container.querySelector(".inbox-bubble");
    expect(bubble?.querySelector(".inbox-bubble__meta")).not.toBeInTheDocument();
    expect(bubble?.querySelector("time")).not.toBeInTheDocument();
    expect(bubble?.querySelector("button")).not.toBeInTheDocument();
    expect(container.querySelector(".inbox-message-meta")).toHaveTextContent("10:06");
    expect(bubble?.querySelector(".sr-only")).toHaveTextContent("你");
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("shows AI identity on the avatar and keeps a grouped reply inside one task card", () => {
    const { container } = render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "process-1",
            speaker: "Aim",
            role: "agent",
            content: "执行环境已准备",
            timestamp: "10:05",
            status: "completed",
            kind: "process",
            execution: [{ id: "step-1", kind: "status", title: "执行环境已准备", status: "done" }],
            executionReply: {
              id: "reply-1",
              speaker: "Aim",
              role: "agent",
              content: "你好，需要我整理什么车型？",
              timestamp: "10:06",
              status: "completed",
            },
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "查看 Aim 的信息" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("AimAI 员工");
    expect(container.querySelectorAll("[data-conversation-message-id]")).toHaveLength(1);
    expect(container.querySelector(".conversation-process__reply")).toHaveTextContent("你好，需要我整理什么车型？");
    expect(container.querySelector(".inbox-message-meta")).toHaveTextContent("10:06");
    expect(container.querySelector(".conversation-process__reply time")).not.toBeInTheDocument();
    expect(container.querySelector(".conversation-process__reply button")).not.toBeInTheDocument();
    expect(container.querySelector(".inbox-message-body > .inbox-message-actions")).toBeInTheDocument();
    expect(container.querySelector(".conversation-process__reply .inbox-bubble__meta")).not.toBeInTheDocument();
  });

  it("renders human and agent mentions with mention type metadata", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-1",
            speaker: "Atlas",
            role: "agent",
            content: "@Mina 请确认预算口径。@Nova 你继续生成草案。",
            timestamp: "10:00",
            status: "completed",
            mentions: [
              {
                humanId: "Mina",
                label: "Mina",
                token: "Mina",
                mentionType: "human",
                inChannel: true,
              },
              {
                agentId: "Nova",
                label: "Nova",
                token: "Nova",
                mentionType: "agent",
                inChannel: true,
              },
            ],
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("@Mina")).toHaveAttribute("data-mention-type", "human");
    expect(screen.getByText("@Nova")).toHaveAttribute("data-mention-type", "agent");
    expect(screen.getByText("@Mina")).toHaveAttribute("title", "人类提及：Mina");
    expect(screen.getByText("@Nova")).toHaveAttribute("title", "AI员工提及：Nova");
  });

  it("renders Markdown message content without interpreting embedded HTML", () => {
    const { container } = render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-markdown",
            speaker: "Atlas",
            role: "agent",
            content: "# 晨间简报\n\n**时间确认**：已完成。\n\n1. **[AI For Beginners](https://github.com/microsoft/AI-For-Beginners)**\n2. `npm test`\n\n<script>window.alert('unsafe')</script>",
            timestamp: "10:00",
            status: "completed",
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "晨间简报" })).toBeInTheDocument();
    expect(container.querySelector(".chat-message-markdown")).not.toHaveClass("wmde-markdown");
    expect(screen.getByText("时间确认").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "AI For Beginners" })).toHaveAttribute(
      "href",
      "https://github.com/microsoft/AI-For-Beginners",
    );
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(container.querySelector("script")).not.toBeInTheDocument();
  });

  it("marks Feishu messages with their source icon", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-feishu",
            speaker: "Mina",
            role: "human",
            content: "请帮我处理这个问题",
            data: { external_provider: "feishu" },
            timestamp: "10:00",
            status: "completed",
          }}
          isOwn={false}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("img", { name: "来自飞书" })).toBeInTheDocument();
  });

  it("renders compact message actions without reserving reading space", () => {
    const { container } = render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-actions",
            speaker: "Atlas",
            role: "agent",
            content: "请确认这条消息。",
            timestamp: "10:00",
            status: "completed",
          }}
          onAcknowledge={vi.fn()}
          onPin={vi.fn()}
          onReply={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(container.querySelector(".inbox-bubble")).toHaveAttribute("tabindex", "0");
    expect(container.querySelector(".inbox-message-body > .inbox-message-actions")).toBeInTheDocument();
    expect(container.querySelector(".inbox-bubble .inbox-message-actions")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回复" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "置顶" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK，标记已读" }).querySelector("svg")).toBeInTheDocument();
  });

  it("copies a completed message through the clipboard action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-copy",
            speaker: "Atlas",
            role: "agent",
            content: "可复制的回复内容",
            timestamp: "10:00",
            status: "completed",
          }}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).toHaveBeenCalledWith("可复制的回复内容");
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("renders partial output inside a pending reply", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-streaming",
            speaker: "Atlas",
            role: "agent",
            content: "正在整理第一部分结果",
            timestamp: "10:00",
            status: "pending",
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("正在整理第一部分结果")).toBeInTheDocument();
    expect(screen.getByLabelText("正在生成")).toBeInTheDocument();
  });

  it("distinguishes delayed queueing from model thinking", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-queued",
            speaker: "Atlas",
            role: "agent",
            content: "Thinking",
            timestamp: "10:00",
            status: "pending",
            data: {
              task_queue_status: "queued",
              task_queue_delayed: "true",
            },
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("等待执行节点")).toBeInTheDocument();
    expect(screen.getByText("执行节点响应较慢，任务仍在队列中")).toBeInTheDocument();
    expect(screen.queryByText("思考中")).not.toBeInTheDocument();
  });

  it("shows environment preparation after the runtime claims a task", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-claimed",
            speaker: "Atlas",
            role: "agent",
            content: "Thinking",
            timestamp: "10:00",
            status: "pending",
            data: { task_queue_status: "claimed" },
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("准备中")).toBeInTheDocument();
    expect(screen.getByText("执行节点已领取，正在准备环境")).toBeInTheDocument();
  });

  it("shows an active execution milestone with expandable raw runtime detail", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-progress",
            speaker: "Atlas",
            role: "agent",
            content: "正在分析任务",
            timestamp: "10:00",
            status: "pending",
            kind: "process",
            processType: "thinking",
            data: { execution_detail: "先检查任务约束，再分析执行路径。" },
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("正在分析任务")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(document.querySelector(".conversation-process__spinner")).toBeInTheDocument();
    expect(screen.getByText("先检查任务约束，再分析执行路径。")).toBeInTheDocument();
  });

  it("renders inline runtime approval actions", async () => {
    const user = userEvent.setup();
    const onReviewApproval = vi.fn(async () => {});

    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-approval",
            speaker: "系统提示",
            role: "agent",
            content: "Atlas requested permission to run Bash",
            code: "approval.created",
            data: {
              approval_id: "approval-1",
              approval_type: "runtime_tool",
              approval_status: "pending",
              agent_id: "Atlas",
              tool_name: "Bash",
              content_preview: "Bash: npm run test",
            },
            timestamp: "10:00",
            status: "completed",
          }}
          onReviewApproval={onReviewApproval}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("等待审批")).toBeInTheDocument();
    expect(screen.getByText("Bash: npm run test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批准" }));

    expect(onReviewApproval).toHaveBeenCalledWith("approval-1", "approved");
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.getByText("已批准")).toBeInTheDocument();
  });

  it("restores inline runtime approval actions when review fails", async () => {
    const user = userEvent.setup();
    const onReviewApproval = vi.fn(async () => {
      throw new Error("approval unavailable");
    });

    render(
      <LanguageProvider initialLanguage="zh">
        <ConversationMessageBubble
          message={{
            id: "message-approval-failure",
            speaker: "系统提示",
            role: "agent",
            content: "Atlas requested permission to run Bash",
            code: "approval.created",
            data: {
              approval_id: "approval-failure",
              approval_type: "runtime_tool",
              approval_status: "pending",
              agent_id: "Atlas",
              tool_name: "Bash",
              content_preview: "Bash: npm run test",
            },
            timestamp: "10:00",
            status: "completed",
          }}
          onReviewApproval={onReviewApproval}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "批准" }));

    expect(onReviewApproval).toHaveBeenCalledWith("approval-failure", "approved");
    expect(screen.getByRole("button", { name: "批准" })).toBeEnabled();
    expect(screen.queryByText("已批准")).not.toBeInTheDocument();
  });
});
