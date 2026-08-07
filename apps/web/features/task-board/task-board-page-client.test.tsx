import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoardPageClient } from "@/features/task-board/task-board-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import type { TaskBoardPageData } from "@/features/dashboard/data";

const taskBoardInvalidation = {
  workspaceId: "workspace-alpha",
  modules: ["task-board", "inbox", "agents"],
  resources: [{ type: "task", id: "task-1" }],
  shell: "counters",
} as const;
const moveTaskToColumnAction = vi.fn<(taskId: string, status: string) => Promise<{
  data: undefined;
  invalidation?: typeof taskBoardInvalidation;
}>>(async () => ({
  data: undefined,
}));
const mockRefresh = vi.fn();
const mockPush = vi.fn();
const runWorkflowAction = vi.fn(async () => ({
  ok: true,
  data: { runId: "run-board-1" },
  invalidation: { workspaceId: "workspace-alpha", modules: ["automations"] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    push: mockPush,
  }),
}));

vi.mock("@/features/workflows/workflow-actions", () => ({
  runWorkflowAction: (input: unknown) => runWorkflowAction(input),
}));

vi.mock("@/features/task-board/actions", () => ({
  moveTaskToColumnAction: (taskId: string, status: string) =>
    moveTaskToColumnAction(taskId, status),
  estimateTaskAction: vi.fn(async () => ({
    taskTitle: "trip",
    channelName: "travel",
    agents: [],
  })),
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

const data: TaskBoardPageData = {
  tasks: [
    {
      id: "task-1",
      title: "整理行程",
      channel: "travel",
      assignee: "Atlas",
      priority: "high",
      status: "todo",
    },
    {
      id: "task-2",
      title: "确认酒店",
      channel: "travel",
      assignee: "Atlas",
      priority: "medium",
      status: "done",
    },
  ],
  columns: [],
  agents: [{ id: "Atlas", name: "Atlas" }],
  channels: [{ name: "travel" }],
  runnableWorkflows: [],
  totalCount: 2,
  todoCount: 1,
  inProgressCount: 0,
  doneCount: 1,
};

describe("TaskBoardPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    moveTaskToColumnAction.mockClear();
    mockRefresh.mockReset();
    mockPush.mockReset();
    runWorkflowAction.mockReset();
    runWorkflowAction.mockResolvedValue({
      ok: true,
      data: { runId: "run-board-1" },
      invalidation: { workspaceId: "workspace-alpha", modules: ["automations"] },
    });
  });

  it("shows one column at a time and updates status on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <TaskBoardPageClient data={data} workspaceSlug="workspace-alpha" />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByText("整理行程")).toBeInTheDocument();
    expect(screen.queryByText("确认酒店")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Done/i }));
    expect(screen.getByText("确认酒店")).toBeInTheDocument();
    expect(screen.queryByText("整理行程")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Todo/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "更新任务状态" }), "done");
    expect(moveTaskToColumnAction).toHaveBeenCalledWith("task-1", "done");
  });

  it("uses module refresh callback after moving a task inside the workbench", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();
    const onDataChanged = vi.fn();
    const onInvalidation = vi.fn();
    moveTaskToColumnAction.mockResolvedValueOnce({
      data: undefined,
      invalidation: taskBoardInvalidation,
    });

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <TaskBoardPageClient data={data} workspaceSlug="workspace-alpha" onDataChanged={onDataChanged} onInvalidation={onInvalidation} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "更新任务状态" }), "done");

    expect(moveTaskToColumnAction).toHaveBeenCalledWith("task-1", "done");
    await waitFor(() => expect(onInvalidation).toHaveBeenCalledWith(taskBoardInvalidation));
    await waitFor(() => expect(onDataChanged).toHaveBeenCalledTimes(1));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("guides an empty board into the message workflow", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <TaskBoardPageClient
            data={{
              ...data,
              tasks: [],
              totalCount: 0,
              todoCount: 0,
              inProgressCount: 0,
              doneCount: 0,
            }}
            workspaceSlug="yootun-all-优惠豚-全体-87e967"
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "任务看板" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往消息" })).toHaveAttribute(
      "href",
      "/w/yootun-all-%E4%BC%98%E6%83%A0%E8%B1%9A-%E5%85%A8%E4%BD%93-87e967/im",
    );
    expect(screen.queryByRole("heading", { name: "Todo" })).not.toBeInTheDocument();
  });

  it("opens the shared workflow builder from the task board", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <TaskBoardPageClient data={data} workspaceSlug="workspace-alpha" />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: "编排任务" })).toHaveAttribute(
      "href",
      "/w/workspace-alpha/automations/new?entry=task-board",
    );
  });

  it("runs an existing published workflow directly from the task board", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <TaskBoardPageClient
            data={{ ...data, runnableWorkflows: [{ id: "wf-daily", name: "每日简报" }] }}
            workspaceSlug="workspace-alpha"
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "选择要运行的编排" }), "wf-daily");
    await user.click(screen.getByRole("button", { name: "运行" }));

    await waitFor(() =>
      expect(runWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf-daily" })),
    );
    // 运行成功后跳转到该运行详情页。
    expect(mockPush).toHaveBeenCalledWith("/w/workspace-alpha/automations/runs/run-board-1");
  });
});
