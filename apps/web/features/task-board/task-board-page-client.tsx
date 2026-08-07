"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveTaskToColumnAction } from "@/features/task-board/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { runWorkflowAction } from "@/features/workflows/workflow-actions";
import { translateWorkflowErrorCode } from "@/features/i18n/presentation";
import type { RunnableWorkflowSummary } from "@/features/workflows/workflow-data";
import type { TaskBoardColumn, TaskBoardGroupBy, TaskBoardPageData } from "@/features/dashboard/data";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { TaskRecord, TaskStatus } from "@dofe-agent/domain/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
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

  const columns = buildClientColumns(data.tasks, groupBy, data);

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
        description={tx("集中查看进行中、阻塞和待处理的任务。任务由消息与自动化流程产生。", "Review active, blocked, and pending work in one place. Tasks are created from messages and automations.")}
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
}: {
  compact: boolean;
  groupBy: TaskBoardGroupBy;
  onMoveStatus?: (taskId: string, status: TaskStatus) => void;
  task: TaskRecord;
  tx: (zh: string, en: string) => string;
  draggable: boolean;
  onDragStart: () => void;
}) {
  return (
    <div
      className={`task-board-card task-board-card--${task.priority}`}
      draggable={draggable}
      onDragStart={onDragStart}
    >
      <div className="task-board-card__header">
        <span className={`task-board-priority task-board-priority--${task.priority}`}>
          {translatePriority(tx, task.priority)}
        </span>
        <span className={`task-board-status-dot task-board-status-dot--${task.status}`} />
      </div>
      <h4 className="task-board-card__title">{task.title}</h4>
      <div className="task-board-card__meta">
        <span>{task.assignee}</span>
        <span>{task.channel}</span>
      </div>
      {task.labels && task.labels.length > 0 ? (
        <div className="task-board-card__labels">
          {task.labels.map((label) => (
            <span className="task-board-label" key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      {compact && groupBy === "status" && onMoveStatus ? (
        <label className="task-board-card__status-control">
          <span>{tx("状态", "Status")}</span>
          <select
            aria-label={tx("更新任务状态", "Update task status")}
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
): TaskBoardColumn[] {
  const sorted = [...tasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  if (groupBy === "status") {
    const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
    const labels: Record<TaskStatus, string> = {
      todo: "Todo",
      in_progress: "In Progress",
      blocked: "Blocked",
      done: "Done",
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
    return priorities.map((priority) => ({
      key: priority,
      label: priority.charAt(0).toUpperCase() + priority.slice(1),
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
 * 为了触发一个现存自动化而被迫新建编排。
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
  const router = useRouter();
  const [selectedId, setSelectedId] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string>();

  async function run(): Promise<void> {
    if (!selectedId || running) return;
    if (!window.confirm(tx("确认立即运行该工作流？", "Run this workflow now?"))) return;
    setRunning(true);
    setNotice(undefined);
    try {
      const result = await runWorkflowAction({
        workflowId: selectedId,
        idempotencyKey: `taskboard-${selectedId}-${Date.now()}`,
        input: {},
      });
      if (!result.ok) {
        setNotice(translateWorkflowErrorCode(result.error.code, tx));
        return;
      }
      router.push(buildWorkspacePath(workspaceSlug, `/automations/runs/${result.data.runId}`));
    } catch {
      setNotice(tx("立即运行未完成，请稍后重试。", "Manual run failed, please retry."));
    } finally {
      setRunning(false);
    }
  }

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
      <button className="knowledge-btn" disabled={!selectedId || running} onClick={() => void run()} style={{ marginTop: 22 }} type="button">
        {running ? tx("启动中", "Starting") : tx("运行", "Run")}
      </button>
      {notice ? <p className="workflow-run__notice" role="status" style={{ flexBasis: "100%" }}>{notice}</p> : null}
    </div>
  );
}
