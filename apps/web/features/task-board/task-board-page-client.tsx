"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveTaskToColumnAction } from "@/features/task-board/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { useManualWorkflowRun } from "@/features/workflows/use-manual-workflow-run";
import type { RunnableWorkflowSummary } from "@/features/workflows/workflow-data";
import type { TaskBoardColumn, TaskBoardGroupBy, TaskBoardPageData } from "@/features/dashboard/data";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { TaskRecord, TaskStatus } from "@dofe-agent/domain/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { EmptyState } from "@/shared/ui/empty-state";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";

const groupByOptions: Array<{ key: TaskBoardGroupBy; label: [string, string] }> = [
  { key: "status", label: ["按状态", "By Status"] },
  { key: "assignee", label: ["按负责人", "By Assignee"] },
  { key: "priority", label: ["按优先级", "By Priority"] },
  { key: "channel", label: ["按群组", "By Group"] },
];

export function TaskBoardPageClient({
  data,
  workspaceSlug,
  onDataChanged,
  onInvalidation,
}: {
  data: TaskBoardPageData;
  workspaceSlug: string;
  onDataChanged?: () => void;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { pushToast } = useFeedbackToast();
  const [groupBy, setGroupBy] = useState<TaskBoardGroupBy>("status");
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null);
  const selectedTaskTriggerRef = useRef<HTMLElement | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const columns = buildClientColumns(data.tasks, groupBy, data, tx);

  useEffect(() => {
    if (!isCompactLayout) {
      setSelectedColumnKey(null);
      return;
    }

    if (!selectedColumnKey || !columns.some((column) => column.key === selectedColumnKey)) {
      setSelectedColumnKey(columns[0]?.key ?? null);
    }
  }, [columns, isCompactLayout, selectedColumnKey]);

  function handleDragStart(taskId: string): void {
    setDraggedTaskId(taskId);
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
  }

  function moveTaskToStatus(taskId: string, status: TaskStatus): void {
    startTransition(async () => {
      await runToastAction({
        action: () => moveTaskToColumnAction(taskId, status),
        onSuccess: async (_data, result) => {
          if (result.invalidation) {
            onInvalidation?.(result.invalidation);
          }
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
      });
    });
  }

  function handleDrop(columnKey: string): void {
    if (!draggedTaskId) return;

    if (groupBy === "status") {
      moveTaskToStatus(draggedTaskId, columnKey as TaskStatus);
    }
    setDraggedTaskId(null);
  }

  const visibleColumns = isCompactLayout
    ? columns.filter((column) => column.key === selectedColumnKey)
    : columns;

  return (
    <section className={`task-board-shell${isCompactLayout ? " task-board-shell--compact" : ""}`}>
      <WorkbenchPageHeader
        actions={(
          <Link
            className="knowledge-btn knowledge-btn--primary"
            href={buildWorkspacePath(workspaceSlug, "/automations/new?entry=task-board")}
          >
            {tx("编排任务", "Orchestrate task")}
          </Link>
        )}
        description={tx("看板用于把消息与自动化产生的任务按状态集中管理，快速识别待办、推进中的工作与阻塞项。点击任务可查看上下文并更新状态。", "The board brings message and automation work into one status view, so you can spot pending, active, and blocked work quickly. Select a task to review its context and update its status.")}
        eyebrow={tx("协作", "Collaboration")}
        meta={(
          <>
            <span>{tx(`${data.todoCount} 待办`, `${data.todoCount} todo`)}</span>
            <span>{tx(`${data.inProgressCount} 进行中`, `${data.inProgressCount} in progress`)}</span>
            <span>{tx(`${data.doneCount} 已完成`, `${data.doneCount} done`)}</span>
          </>
        )}
        title={tx("任务看板", "Task board")}
      />

      {data.runnableWorkflows.length > 0 ? (
        <RunExistingWorkflow workflows={data.runnableWorkflows} workspaceSlug={workspaceSlug} tx={tx} />
      ) : null}

      {data.totalCount === 0 ? (
        <EmptyState
          actionHref={buildWorkspacePath(workspaceSlug, "/im")}
          actionLabel={tx("前往消息", "Open messages")}
          body={tx("在消息中向数字员工分配工作，任务产生后会自动出现在这里。", "Assign work to a digital employee in messages. New tasks will appear here automatically.")}
          eyebrow={tx("任务看板", "Task board")}
          title={tx("还没有任务", "No tasks yet")}
        />
      ) : (
        <>
          <div className="task-board-toolbar">
            <div className="task-board-group-by">
              {groupByOptions.map((option) => (
                <button
                  className={`task-board-group-btn${groupBy === option.key ? " task-board-group-btn--active" : ""}`}
                  key={option.key}
                  onClick={() => setGroupBy(option.key)}
                  type="button"
                >
                  {tx(option.label[0], option.label[1])}
                </button>
              ))}
            </div>
            <div className="task-board-stats">
              <span>{tx(`${data.totalCount} 个任务`, `${data.totalCount} tasks`)}</span>
              <span className="task-board-stat--todo">{tx(`${data.todoCount} 待办`, `${data.todoCount} todo`)}</span>
              <span className="task-board-stat--progress">{tx(`${data.inProgressCount} 进行中`, `${data.inProgressCount} in progress`)}</span>
              <span className="task-board-stat--done">{tx(`${data.doneCount} 完成`, `${data.doneCount} done`)}</span>
            </div>
          </div>

          {isCompactLayout && columns.length > 0 ? (
            <div className="task-board-column-tabs">
              {columns.map((column) => (
                <button
                  className={`task-board-column-tab${selectedColumnKey === column.key ? " task-board-column-tab--active" : ""}`}
                  key={column.key}
                  onClick={() => setSelectedColumnKey(column.key)}
                  type="button"
                >
                  <span>{column.label}</span>
                  <small>{column.tasks.length}</small>
                </button>
              ))}
            </div>
          ) : null}

          <div className={`task-board-columns${isCompactLayout ? " task-board-columns--compact" : ""}`}>
            {visibleColumns.map((column) => (
              <div
                className="task-board-column"
                key={column.key}
                onDragOver={handleDragOver}
                onDrop={() => handleDrop(column.key)}
              >
                <div className="task-board-column__header">
                  <h3>{column.label}</h3>
                  <small>{column.tasks.length}</small>
                </div>
                <div className="task-board-column__cards">
                  {column.tasks.length === 0 ? (
                    <div className="task-board-empty-column">
                      {tx("暂无任务", "No tasks")}
                    </div>
                  ) : (
                    column.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        compact={isCompactLayout}
                        groupBy={groupBy}
                        onMoveStatus={groupBy === "status" ? moveTaskToStatus : undefined}
                        onOpen={(trigger) => {
                          selectedTaskTriggerRef.current = trigger;
                          setSelectedTask(task);
                        }}
                        task={task}
                        tx={tx}
                        draggable={groupBy === "status" && !isCompactLayout}
                        onDragStart={() => handleDragStart(task.id)}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {selectedTask ? (
        <TaskDetailDialog
          onClose={() => setSelectedTask(null)}
          onMoveStatus={(taskId, status) => {
            moveTaskToStatus(taskId, status);
            setSelectedTask(null);
          }}
          task={selectedTask}
          restoreFocusRef={selectedTaskTriggerRef}
          tx={tx}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
    </section>
  );
}

function TaskCard({
  compact,
  groupBy,
  onMoveStatus,
  task,
  tx,
  draggable,
  onDragStart,
  onOpen,
}: {
  compact: boolean;
  groupBy: TaskBoardGroupBy;
  onMoveStatus?: (taskId: string, status: TaskStatus) => void;
  task: TaskRecord;
  tx: (zh: string, en: string) => string;
  draggable: boolean;
  onDragStart: () => void;
  onOpen: (trigger: HTMLElement) => void;
}) {
  return (
    <div
      aria-label={tx(`查看任务：${task.title}`, `View task: ${task.title}`)}
      className={`task-board-card task-board-card--${task.priority} task-board-card--interactive${draggable ? " task-board-card--draggable" : ""}`}
      draggable={draggable}
      onClick={(event) => onOpen(event.currentTarget)}
      onDragStart={onDragStart}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(event.currentTarget);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="task-board-card__header">
        <span className={`task-board-priority task-board-priority--${task.priority}`}>
          {translatePriority(tx, task.priority)}
        </span>
        <span className={`task-board-status-dot task-board-status-dot--${task.status}`} />
      </div>
      <h4 className="task-board-card__title" title={task.title}>{task.title}</h4>
      {task.labels && task.labels.length > 0 ? (
        <div className="task-board-card__labels">
          {task.labels.map((label) => (
            <span className="task-board-label" key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      <div className="task-board-card__meta">
        <span title={task.assignee}>{task.assignee}</span>
        <span title={task.channel}>{task.channel}</span>
      </div>
      {compact && groupBy === "status" && onMoveStatus ? (
        <label className="task-board-card__status-control">
          <span>{tx("状态", "Status")}</span>
          <select
            aria-label={tx("更新任务状态", "Update task status")}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              const nextStatus = event.currentTarget.value as TaskStatus;
              if (nextStatus !== task.status) {
                onMoveStatus(task.id, nextStatus);
              }
            }}
            value={task.status}
          >
            <option value="todo">{tx("待办", "Todo")}</option>
            <option value="in_progress">{tx("进行中", "In Progress")}</option>
            <option value="blocked">{tx("阻塞", "Blocked")}</option>
            <option value="done">{tx("完成", "Done")}</option>
          </select>
        </label>
      ) : null}
    </div>
  );
}

function TaskDetailDialog({
  onClose,
  onMoveStatus,
  restoreFocusRef,
  task,
  tx,
  workspaceSlug,
}: {
  onClose: () => void;
  onMoveStatus: (taskId: string, status: TaskStatus) => void;
  restoreFocusRef: { current: HTMLElement | null };
  task: TaskRecord;
  tx: (zh: string, en: string) => string;
  workspaceSlug: string;
}) {
  const { handleBackdropMouseDown, surfaceRef } = useDialogSurface<HTMLElement>(onClose, restoreFocusRef);

  return (
    <div className="task-board-detail-overlay" onMouseDown={handleBackdropMouseDown}>
      <section
        aria-labelledby="task-board-detail-title"
        aria-modal="true"
        className="task-board-detail-dialog"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="task-board-detail-dialog__header">
          <div>
            <span className="task-board-detail-dialog__eyebrow">{tx("任务详情", "Task details")}</span>
            <h2 id="task-board-detail-title">{task.title}</h2>
          </div>
          <button autoFocus className="task-board-detail-dialog__close" onClick={onClose} type="button">
            {tx("关闭", "Close")}
          </button>
        </header>

        <p className="task-board-detail-dialog__purpose">
          {tx("任务由消息或自动化流程产生。看板负责跟进状态，消息页保留执行上下文。", "Tasks come from messages or automations. Use the board to track status and messages to review execution context.")}
        </p>

        <dl className="task-board-detail-dialog__fields">
          <div><dt>{tx("状态", "Status")}</dt><dd>{translateStatus(tx, task.status)}</dd></div>
          <div><dt>{tx("优先级", "Priority")}</dt><dd>{translatePriority(tx, task.priority)}</dd></div>
          <div><dt>{tx("负责人", "Assignee")}</dt><dd>{task.assignee}</dd></div>
          <div><dt>{tx("群组", "Group")}</dt><dd>{task.channel}</dd></div>
          {task.labels && task.labels.length > 0 ? (
            <div><dt>{tx("标签", "Labels")}</dt><dd>{task.labels.join("、")}</dd></div>
          ) : null}
        </dl>

        <label className="task-board-detail-dialog__status-control">
          <span>{tx("更新状态", "Update status")}</span>
          <select
            aria-label={tx("更新任务状态", "Update task status")}
            onChange={(event) => onMoveStatus(task.id, event.currentTarget.value as TaskStatus)}
            value={task.status}
          >
            <option value="todo">{tx("待办", "Todo")}</option>
            <option value="in_progress">{tx("进行中", "In Progress")}</option>
            <option value="blocked">{tx("阻塞", "Blocked")}</option>
            <option value="done">{tx("完成", "Done")}</option>
          </select>
        </label>

        <footer className="task-board-detail-dialog__footer">
          <Link
            className="task-board-detail-dialog__context-link"
            href={buildWorkspacePath(workspaceSlug, `/im?focus=channel%3A${encodeURIComponent(task.channel)}`)}
            onClick={onClose}
          >
            {tx("查看消息上下文", "View message context")}
          </Link>
          <button className="knowledge-btn knowledge-btn--primary" onClick={onClose} type="button">
            {tx("完成查看", "Done")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function translateStatus(tx: (zh: string, en: string) => string, status: TaskStatus): string {
  const labels: Record<TaskStatus, [string, string]> = {
    todo: ["待办", "Todo"],
    in_progress: ["进行中", "In Progress"],
    blocked: ["阻塞", "Blocked"],
    done: ["完成", "Done"],
  };
  return tx(...labels[status]);
}

function translatePriority(tx: (zh: string, en: string) => string, priority: string): string {
  const map: Record<string, [string, string]> = {
    high: ["高", "High"],
    medium: ["中", "Medium"],
    low: ["低", "Low"],
  };
  const [zh, en] = map[priority] ?? [priority, priority];
  return tx(zh, en);
}

function buildClientColumns(
  tasks: TaskRecord[],
  groupBy: TaskBoardGroupBy,
  data: TaskBoardPageData,
  tx: (zh: string, en: string) => string,
): TaskBoardColumn[] {
  const sorted = [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  if (groupBy === "status") {
    const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
    const labels: Record<TaskStatus, string> = {
      todo: tx("待办", "Todo"),
      in_progress: tx("进行中", "In Progress"),
      blocked: tx("阻塞", "Blocked"),
      done: tx("完成", "Done"),
    };
    return statuses.map((status) => ({
      key: status,
      label: labels[status],
      tasks: sorted.filter((t) => t.status === status),
    }));
  }

  if (groupBy === "assignee") {
    const assigneeMap = new Map(data.agents.map((a) => [a.id, a.name]));
    const assignees = [...new Set(sorted.map((t) => t.assignee))];
    return assignees.map((assignee) => ({
      key: assignee,
      label: assigneeMap.get(assignee) ?? assignee,
      tasks: sorted.filter((t) => t.assignee === assignee),
    }));
  }

  if (groupBy === "priority") {
    const priorities: Array<TaskRecord["priority"]> = ["high", "medium", "low"];
    const labels: Record<TaskRecord["priority"], string> = {
      high: tx("高优先级", "High priority"),
      medium: tx("中优先级", "Medium priority"),
      low: tx("低优先级", "Low priority"),
    };
    return priorities.map((priority) => ({
      key: priority,
      label: labels[priority],
      tasks: sorted.filter((t) => t.priority === priority),
    }));
  }

  const channelNames = [...new Set(sorted.map((t) => t.channel))];
  return channelNames.map((name) => ({
    key: name,
    label: `#${name}`,
    tasks: sorted.filter((t) => t.channel === name),
  }));
}

/**
 * 任务看板入口直接运行「已发布且具备激活 manual 触发器」的已有编排，避免用户
 * 为了触发一个现存自动化而被迫新建编排。运行控制逻辑与工作流列表共用
 * useManualWorkflowRun，保证二次确认、错误展示与跳转路径一致。
 */
function RunExistingWorkflow({
  workflows,
  workspaceSlug,
  tx,
}: {
  workflows: RunnableWorkflowSummary[];
  workspaceSlug: string;
  tx: (zh: string, en: string) => string;
}) {
  const [selectedId, setSelectedId] = useState("");
  const { running, notice, run } = useManualWorkflowRun(workspaceSlug, tx, "taskboard");

  return (
    <div className="task-board__run-existing" style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>{tx("运行已有编排", "Run existing workflow")}</span>
        <select aria-label={tx("选择要运行的编排", "Select a workflow to run")} onChange={(event) => setSelectedId(event.target.value)} value={selectedId}>
          <option value="">{tx("选择编排…", "Select workflow…")}</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
          ))}
        </select>
      </label>
      <button className="knowledge-btn" disabled={!selectedId || running} onClick={() => void run(selectedId)} style={{ marginTop: 22 }} type="button">
        {running ? tx("启动中", "Starting") : tx("运行", "Run")}
      </button>
      {notice ? <p className="workflow-run__notice" role="status" style={{ flexBasis: "100%" }}>{notice}</p> : null}
    </div>
  );
}
