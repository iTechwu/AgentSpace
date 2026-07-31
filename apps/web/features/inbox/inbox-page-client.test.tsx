import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxPageData } from "@/features/dashboard/data";
import { InboxPageClient } from "@/features/inbox/inbox-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const data: InboxPageData = {
  items: [
    {
      id: "task:trip-plan",
      kind: "task",
      title: "旅行计划",
      subtitle: "Planner · todo",
      meta: "travel · 高优先级",
      timestamp: "10:00",
      unread: true,
      statusLabel: "todo",
      statusTone: "warning",
      body: "任务已分派给 Planner。",
      history: [],
      task: {
        id: "task-trip-plan",
        title: "旅行计划",
        channel: "travel",
        assignee: "Planner",
        priority: "high",
        status: "todo",
      },
      execution: {
        queueId: "queue-1",
        queueStatus: "running",
        runtimeId: "runtime-1",
        runtimeName: "Remote Codex",
        provider: "codex",
        daemonMode: "remote",
        sessionId: "sess-1",
        workDir: "/tmp/remote/workdir",
        workDirAccess: "remote",
        workDirHostLabel: "Build Box 1",
        messageCount: 2,
        timeline: [
          {
            id: "event-queued-1",
            type: "queued",
            category: "status",
            title: "Task entered the execution queue",
            severity: "info",
            status: "pending",
            createdAt: "2026-05-06T09:59:00.000Z",
          },
          {
            id: "event-artifact-1",
            type: "artifact_collected",
            category: "artifact",
            title: "Attachment collected: report.pdf",
            summary: "The artifact is available as a workspace attachment.",
            severity: "info",
            status: "succeeded",
            createdAt: "2026-05-06T10:01:00.000Z",
            targetHref: "/api/attachments/att-file",
          },
        ],
      },
    },
  ],
  totalCount: 1,
  unreadCount: 1,
  notificationCount: 0,
  taskCount: 1,
  channelCount: 0,
  activityCount: 0,
};

function renderInbox(pageData: InboxPageData = data) {
  return render(
    <LanguageProvider>
      <InboxPageClient data={pageData} />
    </LanguageProvider>,
  );
}

describe("InboxPageClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps activity categories and the selected timeline in separate panes", () => {
    renderInbox();

    expect(screen.getByRole("heading", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByText("按类型查看员工动态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(document.querySelector(".notification-feed-list")).toBeInTheDocument();
    expect(document.querySelector(".notification-timeline-detail")).toBeInTheDocument();
    expect(document.querySelector(".inbox-chat-pane")).not.toBeInTheDocument();
    expect(document.querySelector(".inbox-composer")).not.toBeInTheDocument();
  });

  it("shows employee actions as chronological timeline entries", () => {
    renderInbox();

    expect(screen.getAllByText("Planner").length).toBeGreaterThan(0);
    expect(screen.getByText("附件已回收： report.pdf")).toBeInTheDocument();
    expect(screen.getByText("已进入执行队列")).toBeInTheDocument();
    expect(screen.getByText("The artifact is available as a workspace attachment.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看关联内容" })).toHaveAttribute("href", "/api/attachments/att-file");
  });

  it("refreshes inbox data while an employee execution is active", () => {
    vi.useFakeTimers();
    const onDataChanged = vi.fn();

    render(
      <LanguageProvider>
        <input aria-label="Workspace search" />
        <InboxPageClient data={data} onDataChanged={onDataChanged} />
      </LanguageProvider>,
    );

    screen.getByRole("textbox", { name: "Workspace search" }).focus();
    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(onDataChanged).toHaveBeenCalledTimes(1);
  });

  it("uses a category to switch the selected activity", async () => {
    const user = userEvent.setup();
    renderInbox({
      ...data,
      items: [
        ...data.items,
        {
          id: "notification:document-1",
          kind: "notification",
          title: "Document shared with you",
          subtitle: "Notification",
          meta: "#research",
          timestamp: "12:00",
          unread: true,
          statusLabel: "Unread",
          statusTone: "positive",
          body: "Planner can now edit Research Plan.",
          actionHref: "/im?focus=channel%3Aresearch",
          channelName: "research",
          history: [],
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "通知" }));

    expect(screen.getByRole("button", { name: "通知" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "系统" })).toBeInTheDocument();
    expect(screen.getAllByText("Document shared with you")).toHaveLength(2);
    expect(screen.getAllByText("Planner can now edit Research Plan.")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "查看关联内容" })).toHaveAttribute("href", "/im?focus=channel%3Aresearch");
  });

  it("shows logs only after the activity category is selected", async () => {
    const user = userEvent.setup();
    renderInbox({
      ...data,
      activityCount: 1,
      items: [
        ...data.items,
        {
          id: "activity:sync-1",
          kind: "activity",
          title: "知识库同步完成",
          subtitle: "工作区日志",
          meta: "知识库",
          timestamp: "10:03",
          unread: false,
          statusLabel: "done",
          statusTone: "positive",
          body: "Research Plan 已同步到知识库。",
          history: [],
        },
      ],
      totalCount: 2,
    });

    expect(screen.queryByText("知识库同步完成")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "日志" }));

    expect(screen.getByRole("button", { name: "日志" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("知识库同步完成")).toHaveLength(2);
  });

  it("renders an empty state when there is no employee activity", () => {
    renderInbox({ ...data, items: [], totalCount: 0, unreadCount: 0 });

    expect(screen.getByText("暂无动态")).toBeInTheDocument();
    expect(screen.getByText("从左侧选择一条动态以查看时间线。")).toBeInTheDocument();
  });
});
