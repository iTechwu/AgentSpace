"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CalendarPageData } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { ScheduledTask, ScheduledTaskRepeat } from "@dofe-agent/domain/workspace";
import {
  createScheduledTaskAction,
  toggleScheduledTaskAction,
  deleteScheduledTaskAction,
} from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { EmptyState } from "@/shared/ui/empty-state";
import { formatCompactTimestamp } from "@/shared/lib/time-format";

const REPEAT_OPTIONS: Array<{ value: ScheduledTaskRepeat; label: string; labelEn: string }> = [
  { value: "once", label: "一次性", labelEn: "Once" },
  { value: "daily", label: "每天", labelEn: "Daily" },
  { value: "weekly", label: "每周", labelEn: "Weekly" },
  { value: "monthly", label: "每月", labelEn: "Monthly" },
  { value: "cron", label: "Cron 表达式", labelEn: "Cron" },
];

export function CalendarPageClient({ data, onDataChanged }: { data: CalendarPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createAssignee, setCreateAssignee] = useState("");
  const [createRepeat, setCreateRepeat] = useState<ScheduledTaskRepeat>("once");
  const [createCron, setCreateCron] = useState("");
  const [createScheduledAt, setCreateScheduledAt] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleCreate(): void {
    if (!createTitle.trim() || !createScheduledAt) return;
    startTransition(async () => {
      await createScheduledTaskAction({
        title: createTitle.trim(),
        description: createDescription.trim() || undefined,
        assignee: createAssignee || undefined,
        repeat: createRepeat,
        cronExpression: createRepeat === "cron" ? createCron : undefined,
        scheduledAt: new Date(createScheduledAt).toISOString(),
      });
      setShowCreateModal(false);
      setCreateTitle("");
      setCreateDescription("");
      setCreateAssignee("");
      setCreateRepeat("once");
      setCreateCron("");
      setCreateScheduledAt("");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleToggle(task: ScheduledTask): void {
    startTransition(async () => {
      await toggleScheduledTaskAction(task.id, task.status === "active" ? "paused" : "active");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteScheduledTaskAction(id);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  const grouped = groupByDate(data.scheduledTasks);

  return (
    <section className="page-shell calendar-page">
      <div className="calendar-layout">
      <div className="calendar-header">
        <div>
          <h1>{tx("日历 / 定时任务", "Calendar / Schedules")}</h1>
          <p className="calendar-header__subtitle">
            {tx(
              `${data.totalCount} 个定时任务，${data.activeCount} 个活跃`,
              `${data.totalCount} scheduled tasks, ${data.activeCount} active`,
            )}
          </p>
        </div>
        <button
          className="knowledge-btn knowledge-btn--primary"
          onClick={() => setShowCreateModal(true)}
          type="button"
        >
          {tx("+ 新建定时", "+ New Schedule")}
        </button>
      </div>

      <div className="calendar-timeline">
        {grouped.length === 0 ? (
          <EmptyState
            actionLabel={tx("新建定时任务", "New schedule")}
            body={tx("从一次性任务、重复任务或 cron 规则开始搭第一条调度。", "Start with a one-off task, recurring task, or cron rule to create the first schedule.")}
            eyebrow={tx("定时任务", "Schedules")}
            onAction={() => setShowCreateModal(true)}
            title={tx("还没有定时任务", "No scheduled tasks yet")}
            variant="warm"
          />
        ) : (
          grouped.map(({ date, tasks }) => (
            <div className="calendar-day" key={date}>
              <h3 className="calendar-day__label">{date}</h3>
              <div className="calendar-day__tasks">
                {tasks.map((task) => (
                  <div className="calendar-task-card" key={task.id}>
                    <div className="calendar-task-card__header">
                      <span className={`calendar-task-card__status calendar-task-card__status--${task.status}`}>
                        {task.status}
                      </span>
                      <strong>{task.title}</strong>
                      <span className="calendar-task-card__repeat">
                        {REPEAT_OPTIONS.find((r) => r.value === task.repeat)?.label ?? task.repeat}
                      </span>
                    </div>
                    {task.description ? (
                      <p className="calendar-task-card__description">{task.description}</p>
                    ) : null}
                    <div className="calendar-task-card__meta">
                      {task.assignee ? `${tx("执行者", "Assignee")}: ${task.assignee} · ` : ""}
                      {tx("计划时间", "Scheduled")}: {formatCompactTimestamp(task.scheduledAt, { emptyFallback: task.scheduledAt })}
                      {task.lastRunAt
                        ? ` · ${tx("上次执行", "Last run")}: ${formatCompactTimestamp(task.lastRunAt, { emptyFallback: task.lastRunAt })}`
                        : ""}
                    </div>
                    <div className="calendar-task-card__actions">
                      <button
                        className="knowledge-btn knowledge-btn--ghost"
                        disabled={isPending}
                        onClick={() => handleToggle(task)}
                        type="button"
                      >
                        {task.status === "active" ? tx("暂停", "Pause") : tx("恢复", "Resume")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--danger"
                        disabled={isPending}
                        onClick={() => handleDelete(task.id)}
                        type="button"
                      >
                        {tx("删除", "Delete")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal knowledge-modal--wide" onClick={(e) => e.stopPropagation()}>
            <h3>{tx("新建定时任务", "New Scheduled Task")}</h3>
            <input
              autoFocus
              className="knowledge-modal__input"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder={tx("任务标题", "Task title")}
            />
            <input
              className="knowledge-modal__input"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder={tx("描述（可选）", "Description (optional)")}
            />
            <div className="automations-create__row">
              <label>{tx("执行者", "Assignee")}</label>
              <select
                className="tables-create__col-type"
                value={createAssignee}
                onChange={(e) => setCreateAssignee(e.target.value)}
              >
                <option value="">{tx("不指定", "Unassigned")}</option>
                {data.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="automations-create__row">
              <label>{tx("重复方式", "Repeat")}</label>
              <select
                className="tables-create__col-type"
                value={createRepeat}
                onChange={(e) => setCreateRepeat(e.target.value as ScheduledTaskRepeat)}
              >
                {REPEAT_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {tx(r.label, r.labelEn)}
                  </option>
                ))}
              </select>
            </div>
            {createRepeat === "cron" ? (
              <input
                className="knowledge-modal__input"
                value={createCron}
                onChange={(e) => setCreateCron(e.target.value)}
                placeholder="Cron (e.g. 0 9 * * 1)"
              />
            ) : null}
            <div className="automations-create__row">
              <label>{tx("计划时间", "Scheduled At")}</label>
              <input
                className="knowledge-modal__input"
                type="datetime-local"
                value={createScheduledAt}
                onChange={(e) => setCreateScheduledAt(e.target.value)}
              />
            </div>
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createTitle.trim() || !createScheduledAt}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}

function groupByDate(tasks: ScheduledTask[]): Array<{ date: string; tasks: ScheduledTask[] }> {
  const groups = new Map<string, ScheduledTask[]>();
  const sorted = [...tasks].sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
  );

  for (const task of sorted) {
    const date = formatCalendarDate(task.scheduledAt);
    const list = groups.get(date) ?? [];
    list.push(task);
    groups.set(date, list);
  }

  return Array.from(groups.entries()).map(([date, tasks]) => ({ date, tasks }));
}

function formatCalendarDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("/");
}
