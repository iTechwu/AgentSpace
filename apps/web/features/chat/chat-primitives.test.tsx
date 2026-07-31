import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAttachmentRow, ConversationMessageBubble } from "@/features/chat/chat-primitives";
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

describe("ChatAttachmentRow", () => {
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
    expect(screen.getByRole("link", { name: /broken-preview\.png/i })).toHaveClass("chat-attachment-file");
    expect(screen.getByText("IMG")).toBeInTheDocument();
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

    expect(screen.getByText("System Notice")).toBeInTheDocument();
    expect(screen.queryByText("系统提示")).not.toBeInTheDocument();
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
    expect(container.querySelector(".inbox-bubble__actions")).toBeInTheDocument();
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

  it("shows an active execution milestone without revealing raw thought content", () => {
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
          }}
        />
      </LanguageProvider>,
    );

    expect(screen.getAllByText("正在分析任务")).toHaveLength(2);
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(document.querySelector(".conversation-process__spinner")).toBeInTheDocument();
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
  });
});
