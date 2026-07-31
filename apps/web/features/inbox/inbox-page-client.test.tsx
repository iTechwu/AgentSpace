import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InboxPageClient } from "@/features/inbox/inbox-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import type { InboxPageData, TaskExecutionTimelineEntry } from "@/features/dashboard/data";
import type { ActionToastResult } from "@/shared/lib/toast-action";

const searchParams = new URLSearchParams();
const mockRefresh = vi.fn();
const actionMocks = vi.hoisted(() => ({
  archiveNotification: vi.fn<(id: string) => Promise<ActionToastResult<undefined>>>(async () => ({ data: undefined })),
  markNotificationRead: vi.fn<(id: string) => Promise<ActionToastResult<undefined>>>(async () => ({ data: undefined })),
  updateTaskStatus: vi.fn<(id: string, status: string) => Promise<ActionToastResult<undefined>>>(async () => ({ data: undefined })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
  useSearchParams: () => ({
    get: (key: string) => searchParams.get(key),
  }),
}));

vi.mock("@/features/inbox/actions", () => ({
  archiveInboxNotificationAction: actionMocks.archiveNotification,
  markInboxNotificationReadAction: actionMocks.markNotificationRead,
  updateInboxTaskStatusAction: actionMocks.updateTaskStatus,
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
      history: [
        {
          id: "history-1",
          role: "agent",
          actor: "Planner",
          timestamp: "10:00",
          body: "我会先整理一版行程。",
          attachments: [
            {
              id: "att-image",
              fileName: "preview.png",
              mediaType: "image/png",
              sizeBytes: 2048,
              kind: "image",
              storedPath: "tos://test-bucket/workspaces/default/attachments/att-image/preview.png",
              storageProvider: "tos",
              storageKey: "workspaces/default/attachments/att-image/preview.png",
            },
            {
              id: "att-file",
              fileName: "summary.pdf",
              mediaType: "application/pdf",
              sizeBytes: 4096,
              kind: "file",
              storedPath: "tos://test-bucket/workspaces/default/attachments/att-file/summary.pdf",
              storageProvider: "tos",
              storageKey: "workspaces/default/attachments/att-file/summary.pdf",
            },
          ],
        },
      ],
      task: {
        id: "task-trip-plan",
        title: "旅行计划",
        channel: "travel",
        assignee: "Planner",
        priority: "high",
        status: "todo",
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

data.items[0]!.execution = {
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
  currentEvent: {
    id: "event-tool-1",
    type: "tool_started",
    category: "tool",
    title: "exec_command started",
    summary: "bash: npm test",
    severity: "info",
    status: "running",
    createdAt: "2026-05-06T10:00:00.000Z",
  },
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
      id: "event-tool-1",
      type: "tool_started",
      category: "tool",
      title: "exec_command started",
      summary: "bash: npm test",
      severity: "info",
      status: "running",
      createdAt: "2026-05-06T10:00:00.000Z",
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
};

function renderInbox(pageData: InboxPageData = data) {
  return render(
    <LanguageProvider>
      <FeedbackToastProvider>
        <InboxPageClient data={pageData} />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

describe("InboxPageClient", () => {
  beforeEach(() => {
    searchParams.forEach((_, key) => searchParams.delete(key));
    mockMatchMedia(false);
    mockRefresh.mockReset();
    actionMocks.markNotificationRead.mockClear();
    actionMocks.archiveNotification.mockClear();
    actionMocks.updateTaskStatus.mockClear();
    vi.useRealTimers();
  });

  it("switches between inbox list and detail on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    renderInbox();

    expect(screen.getByRole("button", { name: /旅行计划/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
    expect(screen.queryByText("查看运行详情")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /旅行计划/i }));

    expect(await screen.findByRole("button", { name: "返回列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设为待开始" })).toBeInTheDocument();
    expect(screen.getByAltText("preview.png")).toHaveAttribute("src", "/api/attachments/att-image");
    expect(screen.getByRole("link", { name: /summary\.pdf/i })).toHaveAttribute("href", "/api/attachments/att-file");
    expect(screen.getByText(/远程执行工作区: Build Box 1/)).not.toBeVisible();
    await user.click(screen.getByText("查看运行详情"));
    expect(screen.getByText(/远程执行工作区: Build Box 1/)).toBeInTheDocument();
    expect(screen.getByText("执行时间线")).toBeInTheDocument();
    expect(screen.getByText(/附件已回收/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回列表" }));

    expect(screen.getByRole("button", { name: /旅行计划/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
  });

  it("polls router.refresh while task execution is active", () => {
    vi.useFakeTimers();

    renderInbox();

    vi.advanceTimersByTime(2100);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("filters execution timeline events and renders actionable failure guidance", async () => {
    const user = userEvent.setup();
    const failureEvent: TaskExecutionTimelineEntry = {
      id: "event-blocked-1",
      type: "blocked",
      category: "error",
      title: "Task is blocked",
      summary: "OpenClaw auth profile is missing.",
      severity: "error",
      status: "failed",
      createdAt: "2026-05-06T10:02:00.000Z",
      nextActions: ["grant_permission", "retry", "handoff"],
    };

    renderInbox({
      ...data,
      items: [
        {
          ...data.items[0]!,
          execution: {
            ...data.items[0]!.execution!,
            currentEvent: failureEvent,
            timeline: [...data.items[0]!.execution!.timeline, failureEvent],
          },
        },
      ],
    });

    expect(screen.getAllByText("任务被阻塞").length).toBeGreaterThan(0);
    expect(screen.getByText("补权限")).toBeInTheDocument();
    expect(screen.getByText("建议重试")).toBeInTheDocument();
    expect(screen.getByText("转交")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "筛选执行事件" }), "tool");

    expect(screen.getByText("bash: npm test")).toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw auth profile/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "筛选执行事件" }), "error");

    expect(screen.getByText(/OpenClaw auth profile/)).toBeInTheDocument();
    expect(screen.queryByText("bash: npm test")).not.toBeInTheDocument();
  });

  it("renders direct conversations inside the channel filter", async () => {
    const user = userEvent.setup();

    renderInbox({
      ...data,
      items: [
        ...data.items,
        {
          id: "channel:direct-atlas",
          kind: "channel",
          channelKind: "direct",
          title: "Atlas",
          subtitle: "Atlas",
          meta: "Direct",
          timestamp: "11:00",
          unread: false,
          statusLabel: "Agent",
          statusTone: "positive",
          body: "我在这里。",
          history: [
            {
              id: "history-direct-1",
              role: "agent",
              actor: "Atlas",
              timestamp: "11:00",
              body: "我在这里。",
            },
          ],
          channelName: "direct-atlas",
          execution: {
            queueId: "group-workspace-1",
            queueStatus: "completed",
            runtimeId: "runtime-direct-1",
            runtimeName: "Remote Codex",
            provider: "codex",
            daemonMode: "remote",
            sessionId: "sess-direct-1",
            workDir: "/tmp/direct-atlas",
            workDirAccess: "remote",
            workDirHostLabel: "Build Box 1",
            errorText: "上一次执行失败",
            messageCount: 0,
            timeline: [],
          },
        },
      ],
      totalCount: 2,
      channelCount: 1,
    });

    await user.click(screen.getByRole("button", { name: "会话" }));

    expect(screen.getByRole("button", { name: /Atlas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Atlas/i }));

    expect(screen.getByText(/最近执行:/)).toBeInTheDocument();
    expect(screen.getByText(/可复用会话:/)).toBeInTheDocument();
    expect(screen.getByText(/远程执行工作区: Build Box 1/)).toBeInTheDocument();
    expect(screen.getByText("上一次执行失败")).toBeInTheDocument();
  });

  it("filters notification items and runs read/archive actions", async () => {
    const user = userEvent.setup();
    renderInbox({
      items: [
        {
          id: "notification:notification-1",
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
          notification: {
            id: "notification-1",
            workspaceId: "default",
            recipientType: "human",
            recipientId: "user-1",
            type: "channel_document.collaborator_added",
            resourceType: "document",
            resourceId: "doc-1",
            channelName: "research",
            title: "Document shared with you",
            body: "Planner can now edit Research Plan.",
            actionHref: "/im?focus=channel%3Aresearch",
            severity: "success",
            status: "unread",
            metadataJson: "{}",
            createdAt: "2026-05-13T12:00:00.000Z",
          },
          history: [
            {
              id: "notification-history-1",
              role: "system",
              actor: "DofeAgent",
              timestamp: "12:00",
              body: "Planner can now edit Research Plan.",
            },
          ],
        },
        data.items[0]!,
      ],
      totalCount: 2,
      unreadCount: 2,
      notificationCount: 1,
      taskCount: 1,
      channelCount: 0,
      activityCount: 0,
    });

    await user.click(screen.getByRole("button", { name: "通知" }));

    expect(screen.getByRole("button", { name: /Document shared with you/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /旅行计划/i })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "标记已读" }));
    expect(actionMocks.markNotificationRead).toHaveBeenCalledWith("notification:notification-1");
    expect(mockRefresh).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "归档" }));
    expect(actionMocks.archiveNotification).toHaveBeenCalledWith("notification:notification-1");
  });

  it("uses module refresh callback instead of router refresh inside the workbench", async () => {
    const user = userEvent.setup();
    const onDataChanged = vi.fn();
    const onInvalidation = vi.fn();
    const invalidation = {
      workspaceId: "workspace-1",
      modules: ["inbox" as const],
      shell: "counters" as const,
    };
    actionMocks.markNotificationRead.mockResolvedValueOnce({
      data: undefined,
      invalidation,
    });

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <InboxPageClient
            data={{
              items: [
                {
                  id: "notification:notification-1",
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
                  notification: {
                    id: "notification-1",
                    workspaceId: "default",
                    recipientType: "human",
                    recipientId: "user-1",
                    type: "channel_document.collaborator_added",
                    resourceType: "document",
                    resourceId: "doc-1",
                    channelName: "research",
                    title: "Document shared with you",
                    body: "Planner can now edit Research Plan.",
                    actionHref: "/im?focus=channel%3Aresearch",
                    severity: "success",
                    status: "unread",
                    metadataJson: "{}",
                    createdAt: "2026-05-13T12:00:00.000Z",
                  },
                  history: [],
                },
              ],
              totalCount: 1,
              unreadCount: 1,
              notificationCount: 1,
              taskCount: 0,
              channelCount: 0,
              activityCount: 0,
            }}
            onDataChanged={onDataChanged}
            onInvalidation={onInvalidation}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "标记已读" }));

    expect(actionMocks.markNotificationRead).toHaveBeenCalledWith("notification:notification-1");
    expect(onInvalidation).toHaveBeenCalledWith(invalidation);
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
