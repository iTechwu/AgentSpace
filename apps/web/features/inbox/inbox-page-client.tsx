"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { InboxItem, InboxItemKind, InboxPageData, TaskExecutionTimelineEntry } from "@/features/dashboard/data";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import { useLanguage } from "@/features/i18n/language-provider";
import {
  translateLedgerBody,
  translateLedgerTitle,
  translatePriority,
  translateQueueStatus as translateQueueStatusValue,
  translateSystemSpeaker,
} from "@/features/i18n/presentation";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar, type GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";

type FilterKey = "all" | InboxItemKind;
const INBOX_REFRESH_POLL_MS = 2000;

const filterLabels: Array<{ key: FilterKey; zh: string; en: string }> = [
  { key: "all", zh: "全部", en: "All" },
  { key: "notification", zh: "通知", en: "Notifications" },
  { key: "task", zh: "任务", en: "Tasks" },
  { key: "channel", zh: "会话", en: "Conversations" },
  { key: "activity", zh: "日志", en: "Activity" },
];

interface InboxTimelineEntry {
  readonly actor: string;
  readonly avatarId: string;
  readonly avatarVariant: GeneratedAvatarVariant;
  readonly body?: string;
  readonly context: string;
  readonly dateTime?: string;
  readonly href?: string;
  readonly icon: AppIconName;
  readonly id: string;
  readonly timestamp: string;
  readonly title: string;
}

export function InboxPageClient({
  data,
  moduleSearchParams,
  onDataChanged,
}: {
  data: InboxPageData;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
}) {
  const { tx } = useLanguage();
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const requestedFilter = searchParams.get("filter");
  const [filter, setFilter] = useState<FilterKey>("all");
  const filteredItems = useMemo(
    () => filter === "all" ? data.items.filter((item) => item.kind !== "activity") : data.items.filter((item) => item.kind === filter),
    [data.items, filter],
  );
  const [selectedId, setSelectedId] = useState<string | null>(data.items[0]?.id ?? null);

  useEffect(() => {
    if (isFilterKey(requestedFilter)) {
      setFilter(requestedFilter);
      return;
    }
    setFilter("all");
  }, [requestedFilter]);

  useEffect(() => {
    if (!filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0]?.id ?? null);
    }
  }, [filteredItems, selectedId]);

  const selectedItem = filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null;
  const timelineEntries = selectedItem ? buildInboxTimeline(selectedItem, tx) : [];
  const shouldPollInboxUpdates = useMemo(
    () => data.items.some((item) =>
      item.execution?.queueStatus === "queued"
      || item.execution?.queueStatus === "claimed"
      || item.execution?.queueStatus === "running"
    ),
    [data.items],
  );

  useAutoRefresh(
    shouldPollInboxUpdates,
    INBOX_REFRESH_POLL_MS,
    onDataChanged,
    { allowWhileInputActive: true },
  );

  return (
    <section className="notification-feed-shell" aria-label={tx("通知", "Notifications")}>
      <aside className="notification-feed-list">
        <header className="notification-feed-list__header">
          <div>
            <h2>{tx("通知", "Notifications")}</h2>
            <p>{tx("按类型查看员工动态", "Browse employee activity by type")}</p>
          </div>
          <span aria-label={tx(`${filteredItems.length} 条动态`, `${filteredItems.length} activities`)}>{filteredItems.length}</span>
        </header>

        <div className="notification-feed-list__filters" aria-label={tx("通知分类", "Notification categories")}>
          {filterLabels.map((item) => (
            <button
              aria-pressed={filter === item.key}
              className={filter === item.key ? "notification-feed-filter notification-feed-filter--active" : "notification-feed-filter"}
              key={item.key}
              onClick={() => setFilter(item.key)}
              type="button"
            >
              {tx(item.zh, item.en)}
            </button>
          ))}
        </div>

        <div className="notification-feed-list__items">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => (
              <button
                aria-pressed={selectedItem?.id === item.id}
                className={selectedItem?.id === item.id ? "notification-feed-row notification-feed-row--active" : "notification-feed-row"}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                type="button"
              >
                <GeneratedAvatar
                  className="notification-feed-row__avatar"
                  id={inboxAvatarId(item)}
                  name={renderInboxActor(item, tx)}
                  variant={inboxAvatarVariant(item)}
                />
                <span className="notification-feed-row__content">
                  <span className="notification-feed-row__title">
                    <strong>{renderInboxActor(item, tx)}</strong>
                    <time>{renderInboxTimestamp(item, tx)}</time>
                  </span>
                  <span>{renderInboxTitle(item, tx)}</span>
                  <small>{renderInboxBody(item, tx)}</small>
                </span>
              </button>
            ))
          ) : (
            <EmptyState
              body={tx("尝试切换分类，查看更多员工动态。", "Try another category to see more employee activity.")}
              title={tx("暂无动态", "No activity")}
            />
          )}
        </div>
      </aside>

      <section className="notification-timeline-detail" aria-labelledby="notification-timeline-title">
        {selectedItem ? (
          <>
            <header className="notification-timeline-detail__header">
              <GeneratedAvatar
                className="notification-timeline-detail__avatar"
                id={inboxAvatarId(selectedItem)}
                name={renderInboxActor(selectedItem, tx)}
                variant={inboxAvatarVariant(selectedItem)}
              />
              <div>
                <h3 id="notification-timeline-title">{renderInboxActor(selectedItem, tx)}</h3>
                <p>{renderInboxContext(selectedItem, tx)}</p>
              </div>
            </header>

            <ol className="notification-timeline">
              {timelineEntries.map((entry) => (
                <li className="notification-timeline__entry" key={entry.id}>
                  <time dateTime={entry.dateTime}>{entry.timestamp}</time>
                  <span className="notification-timeline__marker">
                    <AppIcon name={entry.icon} />
                  </span>
                  <article>
                    <header>
                      <strong>{entry.title}</strong>
                      <span>{entry.context}</span>
                    </header>
                    {entry.body ? <small>{entry.body}</small> : null}
                    {entry.href ? (
                      <a href={entry.href}>
                        <span>{tx("查看关联内容", "View related item")}</span>
                        <AppIcon name="arrowRight" />
                      </a>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <EmptyState
            body={tx("从左侧选择一条动态以查看时间线。", "Select an activity on the left to view its timeline.")}
            title={tx("暂无选中动态", "No activity selected")}
          />
        )}
      </section>
    </section>
  );
}

function buildInboxTimeline(item: InboxItem, tx: (zh: string, en: string) => string): InboxTimelineEntry[] {
  const events = item.execution?.timeline;
  if (events?.length) {
    return [...events].reverse().map((event) => buildExecutionTimelineEntry(item, event, tx));
  }
  return [buildInboxTimelineEntry(item, tx)];
}

function buildExecutionTimelineEntry(
  item: InboxItem,
  event: TaskExecutionTimelineEntry,
  tx: (zh: string, en: string) => string,
): InboxTimelineEntry {
  return {
    actor: renderInboxActor(item, tx),
    avatarId: inboxAvatarId(item),
    avatarVariant: inboxAvatarVariant(item),
    body: event.summary,
    context: renderInboxContext(item, tx),
    dateTime: event.createdAt,
    href: event.targetHref ?? item.actionHref,
    icon: iconForTimelineEvent(event),
    id: `${item.id}:${event.id}`,
    timestamp: formatCompactTimestamp(event.createdAt, { emptyFallback: event.createdAt }),
    title: translateExecutionEventTitle(event, tx),
  };
}

function buildInboxTimelineEntry(item: InboxItem, tx: (zh: string, en: string) => string): InboxTimelineEntry {
  return {
    actor: renderInboxActor(item, tx),
    avatarId: inboxAvatarId(item),
    avatarVariant: inboxAvatarVariant(item),
    body: renderInboxBody(item, tx),
    context: renderInboxContext(item, tx),
    href: item.actionHref,
    icon: item.kind === "task" ? "taskBoard" : item.kind === "activity" ? "info" : item.kind === "channel" ? "messages" : "info",
    id: item.id,
    timestamp: renderInboxTimestamp(item, tx),
    title: renderInboxTitle(item, tx),
  };
}

function isFilterKey(value: string | null): value is FilterKey {
  return value === "all" || value === "notification" || value === "task" || value === "channel" || value === "activity";
}

function renderInboxActor(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) return translateSystemSpeaker(item.task.assignee, tx);
  if (item.kind === "notification") return tx("系统", "System");
  if (item.kind === "activity") return tx("工作区", "Workspace");
  return renderInboxTitle(item, tx);
}

function renderInboxTitle(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "activity" && item.activity) return translateLedgerTitle(item.activity, tx);
  return translateSystemSpeaker(item.title, tx);
}

function renderInboxBody(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) {
    const queueText = item.execution ? ` · ${translateQueueStatus(item.execution.queueStatus, tx)}` : "";
    return tx(
      `处理任务「${item.task.title}」，优先级 ${translatePriorityLabel(item.task.priority, tx)}${queueText}。`,
      `Working on “${item.task.title}” with ${translatePriorityLabel(item.task.priority, tx)} priority${queueText}.`,
    );
  }
  if (item.kind === "activity" && item.activity) return translateLedgerBody(item.activity, tx);
  return translateSystemSpeaker(item.body, tx);
}

function renderInboxContext(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) return `${item.task.channel} · ${translatePriorityLabel(item.task.priority, tx)}`;
  if (item.kind === "activity") return tx("工作区", "Workspace");
  return translateSystemSpeaker(item.subtitle, tx);
}

function renderInboxTimestamp(item: InboxItem, tx: (zh: string, en: string) => string): string {
  return item.kind === "activity" ? tx("最近", "Recent") : item.timestamp;
}

function translateQueueStatus(value: string, tx: (zh: string, en: string) => string): string {
  return translateQueueStatusValue(value, tx) || value;
}

function translatePriorityLabel(value: "low" | "medium" | "high", tx: (zh: string, en: string) => string): string {
  return translatePriority(value, tx) || value;
}

function inboxAvatarVariant(item: InboxItem): GeneratedAvatarVariant {
  if (item.kind === "channel") return item.channelKind === "direct" ? "agent" : "channel";
  if (item.kind === "task") return "agent";
  return "system";
}

function inboxAvatarId(item: InboxItem): string {
  if (item.kind === "task" && item.task) return item.task.assignee;
  return item.channelName ?? item.id;
}

function iconForTimelineEvent(event: TaskExecutionTimelineEntry): AppIconName {
  if (event.category === "tool") return "settings";
  if (event.category === "artifact") return "knowledge";
  if (event.category === "approval") return "approvals";
  if (event.category === "error") return "alertCircle";
  if (event.category === "handoff") return "agents";
  return event.status === "succeeded" ? "checkCircle" : "info";
}

function translateExecutionEventTitle(event: TaskExecutionTimelineEntry, tx: (zh: string, en: string) => string): string {
  if (event.type === "queued") return tx("已进入执行队列", "Queued for execution");
  if (event.type === "assigned") return tx("执行引擎已接手", "Runtime claimed the task");
  if (event.type === "workspace_prepared") return tx("执行已开始", "Execution started");
  if (event.type === "context_loaded") return tx("上下文已加载", "Context loaded");
  if (event.type === "artifact_detected") return tx("检测到产物", "Artifacts detected");
  if (event.type === "approval_requested") return tx("等待审批", "Approval requested");
  if (event.type === "message_posted") return tx("AI员工回复已生成", "AI employee response captured");
  if (event.type === "completed") return tx("任务已完成", "Task completed");
  if (event.type === "blocked") return tx("任务被阻塞", "Task blocked");
  if (event.type === "failed") return tx("任务失败", "Task failed");
  if (event.type === "cancelled") return tx("任务已取消", "Task cancelled");
  if (event.title.startsWith("Attachment collected:")) return tx(event.title.replace("Attachment collected:", "附件已回收："), event.title);
  if (event.title.startsWith("Skill import collected:")) return tx(event.title.replace("Skill import collected:", "Skill 已导入："), event.title);
  return event.title;
}
