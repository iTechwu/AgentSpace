"use client";

import Link from "next/link";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import type { CalendarPageData } from "@/features/dashboard/data";
import type { ScheduledTaskRepeat } from "@dofe-agent/domain/workspace";
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

export function CalendarPageClient({ data, workspaceSlug }: { data: CalendarPageData; workspaceSlug: string }) {
  const { tx } = useLanguage();

  const grouped = groupByDate(data.scheduledTasks);
  const createWorkflowHref = buildWorkspacePath(workspaceSlug, "/automations/new?entry=calendar");

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
        <Link
          className="knowledge-btn knowledge-btn--primary"
          href={createWorkflowHref}
        >
          {tx("+ 新建定时", "+ New Schedule")}
        </Link>
      </div>

      <div className="calendar-timeline">
        {grouped.length === 0 ? (
          <EmptyState
            actionLabel={tx("新建定时任务", "New schedule")}
            body={tx("从一次性任务、重复任务或 cron 规则开始搭第一条调度。", "Start with a one-off task, recurring task, or cron rule to create the first schedule.")}
            eyebrow={tx("定时任务", "Schedules")}
            actionHref={createWorkflowHref}
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
                      <span className="calendar-task-card__repeat">
                        {task.sourceKind === "workflow"
                          ? tx("工作流计划", "Workflow schedule")
                          : task.migrationStatus === "needs_migration"
                            ? tx("需迁移", "Migration needed")
                            : tx("旧版计划", "Legacy schedule")}
                      </span>
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
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      </div>
    </section>
  );
}

type CalendarTask = CalendarPageData["scheduledTasks"][number];

function groupByDate(tasks: CalendarTask[]): Array<{ date: string; tasks: CalendarTask[] }> {
  const groups = new Map<string, CalendarTask[]>();
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
