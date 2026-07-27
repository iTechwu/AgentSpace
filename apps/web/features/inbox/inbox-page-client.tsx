"use client";

import { memo, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  archiveInboxNotificationAction,
  markInboxNotificationReadAction,
  updateInboxTaskStatusAction,
} from "@/features/inbox/actions";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { ConversationMessageBubble } from "@/features/chat/chat-primitives";
import type { InboxItem, InboxItemKind, InboxPageData, RouterExecutionView, TaskExecutionTimelineCategory, TaskExecutionTimelineEntry } from "@/features/dashboard/data";
import type { TaskStatus } from "@dofe-agent/domain/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";
import {
  translateAgentStatus,
  translateLedgerBody,
  translateLedgerTitle,
  translatePriority,
  translateQueueStatus as translateQueueStatusValue,
  translateSystemSpeaker,
  translateTaskStatus,
} from "@/features/i18n/presentation";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { FeedbackBanner } from "@/shared/ui/feedback-banner";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { useResizablePane } from "@/shared/lib/use-resizable-pane";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { PaneResizeHandle } from "@/shared/ui/pane-resize-handle";
import { GeneratedAvatar, type GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";

type FilterKey = "all" | InboxItemKind;
type TimelineFilterKey = "all" | TaskExecutionTimelineCategory;
const INBOX_REFRESH_POLL_MS = 2000;

const filterLabels: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "notification", label: "通知" },
  { key: "task", label: "任务" },
  { key: "channel", label: "会话" },
  { key: "activity", label: "日志" },
];

const timelineFilterLabels: Array<{ key: TimelineFilterKey; zh: string; en: string }> = [
  { key: "all", zh: "全部", en: "All" },
  { key: "status", zh: "状态", en: "Status" },
  { key: "tool", zh: "工具", en: "Tools" },
  { key: "artifact", zh: "产物", en: "Artifacts" },
  { key: "approval", zh: "审批", en: "Approvals" },
  { key: "error", zh: "错误", en: "Errors" },
  { key: "handoff", zh: "交接", en: "Handoffs" },
];

export function InboxPageClient({
  data,
  moduleSearchParams,
  onDataChanged,
  onInvalidation,
}: {
  data: InboxPageData;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const requestedFilter = searchParams.get("filter");
  const requestedFocus = searchParams.get("focus");
  const { pushToast } = useFeedbackToast();
  const [selectedId, setSelectedId] = useState<string | null>(data.items[0]?.id ?? null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilterKey>("all");
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [isPending, startTransition] = useTransition();
  const listPaneResize = useResizablePane({
    defaultWidth: 340,
    maxWidth: 560,
    minWidth: 300,
    storageKey: "dofe-agent.inbox-list-width",
  });

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

  const filteredItems = useMemo(() => {
    if (filter === "all") {
      return data.items;
    }
    return data.items.filter((item) => item.kind === filter);
  }, [data.items, filter]);

  useEffect(() => {
    if (!filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0]?.id ?? null);
    }
  }, [filteredItems, selectedId]);

  useEffect(() => {
    if (
      requestedFilter === "notification" ||
      requestedFilter === "task" ||
      requestedFilter === "channel" ||
      requestedFilter === "activity"
    ) {
      setFilter(requestedFilter);
    } else {
      setFilter("all");
    }
  }, [requestedFilter]);

  useEffect(() => {
    if (!requestedFocus) {
      return;
    }

    if (data.items.some((item) => item.id === requestedFocus)) {
      setSelectedId(requestedFocus);
      if (isCompactLayout) {
        setMobilePane("detail");
      }
    }
  }, [data.items, isCompactLayout, requestedFocus]);

  const selectedItem = filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null;
  const shouldPollInboxUpdates = useMemo(
    () =>
      data.items.some(
        (item) =>
          item.execution?.queueStatus === "queued"
          || item.execution?.queueStatus === "claimed"
          || item.execution?.queueStatus === "running",
      ),
    [data.items],
  );

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    if (!selectedItem) {
      setMobilePane("list");
    }
  }, [isCompactLayout, selectedItem]);

  useAutoRefresh(shouldPollInboxUpdates, INBOX_REFRESH_POLL_MS, onDataChanged);

  function updateTaskStatus(taskId: string, status: TaskStatus): void {
    startTransition(async () => {
      await runToastAction({
        action: () => updateInboxTaskStatusAction(taskId, status),
        onSuccess: async (_data, result) => {
          if (result.invalidation) {
            onInvalidation?.(result.invalidation);
          }
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: {
          zh: "更新失败，请稍后重试。",
          en: "Update failed. Please try again.",
        },
      });
    });
  }

  function markNotificationRead(notificationId: string): void {
    startTransition(async () => {
      await runToastAction({
        action: () => markInboxNotificationReadAction(notificationId),
        onSuccess: async (_data, result) => {
          if (result.invalidation) {
            onInvalidation?.(result.invalidation);
          }
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: {
          zh: "更新通知失败，请稍后重试。",
          en: "Notification update failed. Please try again.",
        },
      });
    });
  }

  function archiveNotification(notificationId: string): void {
    startTransition(async () => {
      await runToastAction({
        action: () => archiveInboxNotificationAction(notificationId),
        onSuccess: async (_data, result) => {
          if (result.invalidation) {
            onInvalidation?.(result.invalidation);
          }
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: {
          zh: "归档通知失败，请稍后重试。",
          en: "Notification archive failed. Please try again.",
        },
      });
    });
  }

  const showListPane = !isCompactLayout || mobilePane === "list";
  const showDetailPane = !isCompactLayout || mobilePane === "detail";
  return (
    <section className={`inbox-shell${isCompactLayout ? " inbox-shell--compact" : ""}`} style={listPaneResize.paneStyle}>
      {showListPane ? (
        <aside className="inbox-list-pane">
          <div className="inbox-list-pane__header">
            <div>
              <h2>{tx("通知", "Feed")}</h2>
            </div>
            <span className="panel-note">{filteredItems.length}</span>
          </div>

          <div className="filter-row inbox-filter-row">
            {filterLabels.map((item) => (
              <button
                className={`filter-pill${filter === item.key ? " filter-pill--active" : ""}`}
                key={item.key}
                onClick={() => {
                  setFilter(item.key);
                  if (isCompactLayout) {
                    setMobilePane("list");
                  }
                }}
                type="button"
              >
                {tx(item.label, labelForInboxFilter(item.key))}
              </button>
            ))}
          </div>

          <div className="inbox-conversation-list">
            {filteredItems.length > 0 ? (
              filteredItems.map((item) => (
                <InboxRow
                  item={item}
                  key={item.id}
                  selected={selectedItem?.id === item.id}
                  onSelect={(id) => {
                    setSelectedId(id);
                    if (isCompactLayout) {
                      setMobilePane("detail");
                    }
                  }}
                />
              ))
            ) : (
              <EmptyState
                body={tx("当前筛选下没有条目。换一个过滤器，或者先去 AI员工 页面创建 AI员工 / 启动容器。", "No items match this filter. Try another filter, or create an AI employee and start a container first.")}
                title={tx("收件箱为空", "Inbox is empty")}
              />
            )}
          </div>
        </aside>
      ) : null}

      {!isCompactLayout && showListPane && showDetailPane ? (
        <PaneResizeHandle
          label={tx("调整通知列表宽度", "Resize feed list")}
          maxValue={listPaneResize.maxWidth}
          minValue={listPaneResize.minWidth}
          onKeyDown={listPaneResize.onHandleKeyDown}
          onPointerDown={listPaneResize.onHandlePointerDown}
          value={listPaneResize.width}
        />
      ) : null}

      {showDetailPane ? (
        <section className="inbox-chat-pane">
          {selectedItem ? (
            <>
              <header className="inbox-chat-header">
                <div className="inbox-chat-header__main">
                  {isCompactLayout ? (
                  <button
                    aria-label={tx("返回列表", "Back to list")}
                    className="inbox-chat-header__back"
                    onClick={() => setMobilePane("list")}
                    type="button"
                  >
                      <AppIcon name="arrowLeft" />
                    </button>
                  ) : null}
                  <GeneratedAvatar
                    className={`inbox-chat-header__avatar inbox-chat-header__avatar--${selectedItem.kind}`}
                    id={inboxAvatarId(selectedItem)}
                    name={renderInboxTitle(selectedItem, tx)}
                    variant={inboxAvatarVariant(selectedItem)}
                  />
                  <div>
                    <h3>{renderInboxTitle(selectedItem, tx)}</h3>
                    <p>{renderInboxSubtitle(selectedItem, tx)}</p>
                  </div>
                </div>
                <div className="inbox-chat-header__meta">
                  <span className={`status-chip status-chip--${selectedItem.statusTone}`}>{translateStatusLabel(selectedItem.statusLabel, tx)}</span>
                  <span className="panel-note">{renderInboxMeta(selectedItem, tx)}</span>
                </div>
              </header>

              {selectedItem.execution ? (
                <div className="meta-strip inbox-execution-strip">
                  <span>
                    {selectedItem.kind === "task"
                      ? tx(`执行状态: ${translateQueueStatus(selectedItem.execution.queueStatus, tx)}`, `Execution: ${translateQueueStatus(selectedItem.execution.queueStatus, tx)}`)
                      : tx(`最近执行: ${translateQueueStatus(selectedItem.execution.queueStatus, tx)}`, `Last execution: ${translateQueueStatus(selectedItem.execution.queueStatus, tx)}`)}
                  </span>
                  {selectedItem.execution.runtimeId ? (
                    <span>{tx(`运行时: ${selectedItem.execution.runtimeName ?? selectedItem.execution.runtimeId}`, `Runtime: ${selectedItem.execution.runtimeName ?? selectedItem.execution.runtimeId}`)}</span>
                  ) : null}
                  {selectedItem.execution.provider ? (
                    <span>{`Provider: ${selectedItem.execution.provider}`}</span>
                  ) : null}
                  {selectedItem.kind === "task" ? <span>Task Messages: {selectedItem.execution.messageCount}</span> : null}
                </div>
              ) : null}

              {selectedItem.execution?.workDir || selectedItem.execution?.sessionId || selectedItem.execution?.router ? (
                <div className="meta-strip inbox-execution-strip">
                  {selectedItem.execution.router ? (
                    <span>
                      {tx(
                        `Router Session: ${selectedItem.execution.router.routerSessionId}`,
                        `Router Session: ${selectedItem.execution.router.routerSessionId}`,
                      )}
                    </span>
                  ) : null}
                  {selectedItem.execution.sessionId ? (
                    <span>
                      {selectedItem.kind === "task"
                        ? `Session: ${selectedItem.execution.sessionId}`
                        : tx(`可复用会话: ${selectedItem.execution.sessionId}`, `Reusable session: ${selectedItem.execution.sessionId}`)}
                    </span>
                  ) : null}
                  {selectedItem.execution.router ? (
                    <span>
                      {tx(
                        `连续性: ${translateContinuationMode(selectedItem.execution.router.continuationMode, tx)} · ${selectedItem.execution.router.attempts.length} 次尝试`,
                        `Continuity: ${translateContinuationMode(selectedItem.execution.router.continuationMode, tx)} · ${selectedItem.execution.router.attempts.length} attempt(s)`,
                      )}
                    </span>
                  ) : null}
                  {selectedItem.execution.workDir ? <span>{renderExecutionWorkArea(selectedItem.execution, tx)}</span> : null}
                </div>
              ) : null}

              {selectedItem.execution?.errorText ? (
                <FeedbackBanner feedback={{ tone: "error", message: selectedItem.execution.errorText }} />
              ) : null}

              {selectedItem.execution?.timeline.length ? (
                <ExecutionTimelinePanel
                  execution={selectedItem.execution}
                  filter={timelineFilter}
                  onFilterChange={setTimelineFilter}
                />
              ) : null}

              <div className="inbox-chat-thread">
                {selectedItem.history.length > 0 ? (
                  selectedItem.history.map((entry) => (
                    <ConversationMessageBubble
                      key={entry.id}
                      message={{
                        id: entry.id,
                        speaker: entry.actor,
                        role: entry.role === "human" || entry.role === "user" ? "human" : "agent",
                        content: selectedItem.kind === "activity" && selectedItem.activity
                          ? renderActivityBody(selectedItem.activity, tx)
                          : entry.body,
                        timestamp: selectedItem.kind === "activity" && selectedItem.activity
                          ? renderActivityTimestamp(selectedItem.activity, tx)
                          : entry.timestamp,
                        status: entry.status ?? "completed",
                        attachments: entry.attachments,
                      }}
                      ownSpeakerLabel={translateSystemSpeaker(entry.actor, tx)}
                    />
                  ))
                ) : (
                  <EmptyState body={tx("这个条目还没有可展示的上下文。", "There is no displayable context for this item yet.")} title={tx("暂无上下文", "No context")} />
                )}
              </div>

              <div className="inbox-composer">
                {selectedItem.kind === "task" && selectedItem.task ? (
                  <div className="detail-actions">
                    {(["todo", "in_progress", "blocked", "done"] as const).map((status) => (
                      <button
                        className={`action-button${selectedItem.task?.status === status ? " action-button--active" : ""}`}
                        disabled={isPending}
                        key={status}
                        onClick={() => updateTaskStatus(selectedItem.task!.id, status)}
                        type="button"
                      >
                        {renderTaskActionLabel(status, tx)}
                      </button>
                    ))}
                  </div>
                ) : null}

                {selectedItem.kind === "notification" && selectedItem.notification ? (
                  <div className="detail-actions">
                    {selectedItem.notification.status === "unread" ? (
                      <button
                        className="action-button"
                        disabled={isPending}
                        onClick={() => markNotificationRead(selectedItem.id)}
                        type="button"
                      >
                        {tx("标记已读", "Mark read")}
                      </button>
                    ) : null}
                    <button
                      className="action-button"
                      disabled={isPending}
                      onClick={() => archiveNotification(selectedItem.id)}
                      type="button"
                    >
                      {tx("归档", "Archive")}
                    </button>
                    {selectedItem.actionHref ? (
                      <a className="action-button" href={selectedItem.actionHref}>
                        <AppIcon name="open" />
                        <span>{tx("打开", "Open")}</span>
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <div className="inbox-composer__box">
                  <span>{tx(`发送给 ${selectedItem.title}`, `Send to ${selectedItem.title}`)}</span>
                  <button className="inbox-composer__send" disabled type="button">
                    {tx("发送", "Send")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <EmptyState body={tx("中栏还没有任何会话。", "There is no conversation in the main pane yet.")} title={tx("没有选中内容", "Nothing selected")} />
          )}
        </section>
      ) : null}
    </section>
  );
}

const InboxRow = memo(function InboxRow({
  item,
  selected,
  onSelect,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { tx } = useLanguage();
  return (
    <button
      className={`inbox-row${selected ? " inbox-row--active" : ""}`}
      onClick={() => onSelect(item.id)}
      type="button"
    >
      <GeneratedAvatar
        className={`inbox-row__avatar inbox-row__avatar--${item.kind}`}
        id={inboxAvatarId(item)}
        name={renderInboxTitle(item, tx)}
        variant={inboxAvatarVariant(item)}
      />
      <div className="inbox-row__content">
        <div className="inbox-row__title">
          <div className="inbox-row__title-copy">
            <strong>{renderInboxTitle(item, tx)}</strong>
            <span className={`status-chip status-chip--${item.statusTone}`}>{translateStatusLabel(item.statusLabel, tx)}</span>
          </div>
          <span>{renderInboxTimestamp(item, tx)}</span>
        </div>
        <div className="inbox-row__subtitle">
          <span>{renderInboxSubtitle(item, tx)}</span>
          {item.unread ? <i className="unread-dot" /> : null}
        </div>
        <p>{renderInboxBody(item, tx)}</p>
      </div>
    </button>
  );
});

function ExecutionTimelinePanel({
  execution,
  filter,
  onFilterChange,
}: {
  execution: NonNullable<InboxItem["execution"]>;
  filter: TimelineFilterKey;
  onFilterChange: (filter: TimelineFilterKey) => void;
}) {
  const { tx } = useLanguage();
  const currentEvent = execution.currentEvent ?? execution.timeline.at(-1);
  const filteredEvents = filter === "all"
    ? execution.timeline
    : execution.timeline.filter((event) => event.category === filter);

  return (
    <section className="execution-timeline-panel">
      <div className="execution-timeline-panel__header">
        <div>
          <h4>{tx("执行时间线", "Execution Timeline")}</h4>
          {currentEvent ? (
            <p>{tx(`当前：${translateExecutionEventTitle(currentEvent, tx)}`, `Now: ${translateExecutionEventTitle(currentEvent, tx)}`)}</p>
          ) : null}
        </div>
        <span className={`execution-timeline-status execution-timeline-status--${currentEvent?.severity ?? "info"}`}>
          {currentEvent ? translateExecutionStatus(currentEvent, tx) : tx("未开始", "Not started")}
        </span>
      </div>
      <div className="filter-row execution-timeline-filter-row">
        {timelineFilterLabels.map((item) => (
          <button
            className={`filter-pill${filter === item.key ? " filter-pill--active" : ""}`}
            key={item.key}
            onClick={() => onFilterChange(item.key)}
            type="button"
          >
            {tx(item.zh, item.en)}
          </button>
        ))}
      </div>
      {execution.router ? (
        <div className="meta-strip inbox-execution-strip">
          <span>{`Router: ${execution.router.routerSessionId}`}</span>
          <span>{tx(`尝试: ${execution.router.attempts.length}`, `Attempts: ${execution.router.attempts.length}`)}</span>
          <span>{translateContinuationMode(execution.router.continuationMode, tx)}</span>
          {execution.router.providerSessions.length > 0 ? (
            <span>
              {tx(
                `Provider sessions: ${execution.router.providerSessions.map((session) => `${session.provider}/${session.status}`).join(", ")}`,
                `Provider sessions: ${execution.router.providerSessions.map((session) => `${session.provider}/${session.status}`).join(", ")}`,
              )}
            </span>
          ) : null}
        </div>
      ) : null}
      <ol className="execution-timeline-list">
        {filteredEvents.length > 0 ? (
          filteredEvents.map((event) => (
            <li className={`execution-timeline-event execution-timeline-event--${event.severity}`} key={event.id}>
              <span className={`execution-timeline-event__marker execution-timeline-event__marker--${event.category}`}>
                <AppIcon name={iconForTimelineEvent(event)} />
              </span>
              <div className="execution-timeline-event__body">
                <div className="execution-timeline-event__title-row">
                  <strong>{translateExecutionEventTitle(event, tx)}</strong>
                  <time>{formatTimelineTimestamp(event.createdAt)}</time>
                </div>
                {event.summary ? <p>{event.summary}</p> : null}
                <div className="execution-timeline-event__meta">
                  <span>{translateTimelineCategory(event.category, tx)}</span>
                  <span>{translateExecutionStatus(event, tx)}</span>
                  {event.targetHref ? (
                    <a href={event.targetHref}>
                      <AppIcon name="open" />
                      <span>{tx("打开", "Open")}</span>
                    </a>
                  ) : null}
                </div>
                {event.nextActions?.length ? (
                  <div className="execution-timeline-event__actions">
                    {event.nextActions.map((action) => (
                      <span key={action}>{translateTimelineAction(action, tx)}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))
        ) : (
          <li className="execution-timeline-empty">{tx("当前过滤条件下没有事件。", "No events match this filter.")}</li>
        )}
      </ol>
    </section>
  );
}

function renderExecutionWorkArea(
  execution: NonNullable<InboxItem["execution"]>,
  tx: (zh: string, en: string) => string,
): string {
  if (execution.workDirAccess === "remote") {
    const hostLabel = execution.workDirHostLabel ?? execution.runtimeName ?? execution.runtimeId;
    return tx(`远程执行工作区: ${hostLabel} · 路径仅供诊断`, `Remote execution workspace: ${hostLabel} · path shown for diagnostics only`);
  }

  return tx(`执行工作区: ${execution.workDir ?? tx("未返回", "Unavailable")}`, `Execution workspace: ${execution.workDir ?? tx("未返回", "Unavailable")}`);
}

function translateContinuationMode(
  mode: RouterExecutionView["continuationMode"],
  tx: (zh: string, en: string) => string,
): string {
  if (mode === "same_provider_resume") return tx("同 provider 续跑", "Same-provider resume");
  if (mode === "fallback") return tx("Fallback 冷重建", "Fallback cold rebuild");
  return tx("平台上下文冷重建", "Platform cold rebuild");
}

function iconForTimelineEvent(event: TaskExecutionTimelineEntry): AppIconName {
  if (event.category === "tool") return "settings";
  if (event.category === "artifact") return "knowledge";
  if (event.category === "approval") return "approvals";
  if (event.category === "error") return "alertCircle";
  if (event.category === "handoff") return "agents";
  if (event.status === "succeeded") return "checkCircle";
  return "info";
}

function translateTimelineCategory(
  category: TaskExecutionTimelineCategory,
  tx: (zh: string, en: string) => string,
): string {
  if (category === "tool") return tx("工具", "Tool");
  if (category === "artifact") return tx("产物", "Artifact");
  if (category === "approval") return tx("审批", "Approval");
  if (category === "error") return tx("错误", "Error");
  if (category === "handoff") return tx("交接", "Handoff");
  return tx("状态", "Status");
}

function translateExecutionStatus(
  event: TaskExecutionTimelineEntry,
  tx: (zh: string, en: string) => string,
): string {
  if (event.status === "pending") return tx("等待中", "Pending");
  if (event.status === "running") return tx("执行中", "Running");
  if (event.status === "succeeded") return tx("已完成", "Succeeded");
  if (event.status === "failed") return tx("需要处理", "Needs action");
  if (event.severity === "error") return tx("错误", "Error");
  if (event.severity === "warning") return tx("警告", "Warning");
  return tx("信息", "Info");
}

function translateExecutionEventTitle(
  event: TaskExecutionTimelineEntry,
  tx: (zh: string, en: string) => string,
): string {
  if (event.type === "queued") return tx("已进入执行队列", "Queued for execution");
  if (event.type === "assigned") return tx("执行引擎已接手", "Runtime claimed the task");
  if (event.type === "workspace_prepared") return tx("执行已开始", "Execution started");
  if (event.type === "context_loaded") return tx("上下文已加载", "Context loaded");
  if (event.type === "artifact_detected") return tx("检测到产物", "Artifacts detected");
  if (event.type === "approval_requested") return tx("等待审批", "Approval requested");
  if (event.type === "message_posted") return tx("AI员工 回复已生成", "AI employee response captured");
  if (event.type === "completed") return tx("任务已完成", "Task completed");
  if (event.type === "blocked") return tx("任务被阻塞", "Task blocked");
  if (event.type === "failed") return tx("任务失败", "Task failed");
  if (event.type === "cancelled") return tx("任务已取消", "Task cancelled");
  if (event.title.startsWith("Attachment collected:")) {
    return tx(event.title.replace("Attachment collected:", "附件已回收："), event.title);
  }
  if (event.title.startsWith("Skill import collected:")) {
    return tx(event.title.replace("Skill import collected:", "Skill 已导入："), event.title);
  }
  return event.title;
}

function translateTimelineAction(
  action: NonNullable<TaskExecutionTimelineEntry["nextActions"]>[number],
  tx: (zh: string, en: string) => string,
): string {
  if (action === "retry") return tx("建议重试", "Retry");
  if (action === "grant_permission") return tx("补权限", "Grant permission");
  if (action === "handoff") return tx("转交", "Handoff");
  if (action === "mark_blocked") return tx("标记阻塞", "Mark blocked");
  return tx("回退", "Rollback");
}

function formatTimelineTimestamp(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}

function labelForInboxFilter(filter: FilterKey): string {
  if (filter === "notification") {
    return "Notifications";
  }
  if (filter === "task") {
    return "Tasks";
  }
  if (filter === "channel") {
    return "Channels";
  }
  if (filter === "activity") {
    return "Activity";
  }
  return "All";
}

function inboxAvatarVariant(item: InboxItem): GeneratedAvatarVariant {
  if (item.kind === "channel") {
    return item.channelKind === "direct" ? "agent" : "channel";
  }
  if (item.kind === "task") {
    return "agent";
  }
  return "system";
}

function inboxAvatarId(item: InboxItem): string {
  if (item.kind === "task" && item.task) {
    return item.task.assignee;
  }
  if (item.kind === "channel") {
    return item.channelName ?? item.id;
  }
  return item.id;
}

function renderTaskActionLabel(status: TaskStatus, tx: (zh: string, en: string) => string): string {
  if (status === "todo") {
    return tx("设为待开始", "Mark todo");
  }
  if (status === "in_progress") {
    return tx("设为进行中", "Mark in progress");
  }
  if (status === "blocked") {
    return tx("标记阻塞", "Mark blocked");
  }
  return tx("标记完成", "Mark done");
}

function renderInboxSubtitle(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) {
    return `${translateSystemSpeaker(item.task.assignee, tx)} · ${translateStatusLabel(item.statusLabel, tx)}`;
  }
  if (item.kind === "activity") {
    return tx("工作区日志", "Workspace log");
  }
  return translateSystemSpeaker(item.subtitle, tx);
}

function renderInboxTitle(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "activity" && item.activity) {
    return renderActivityTitle(item.activity, tx);
  }
  return translateSystemSpeaker(item.title, tx);
}

function renderInboxTimestamp(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "activity" && item.activity) {
    return renderActivityTimestamp(item.activity, tx);
  }
  return item.timestamp;
}

function renderInboxBody(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) {
    const queueText = item.execution ? ` · ${translateQueueStatus(item.execution.queueStatus, tx)}` : "";
    return tx(
      `任务已分派给 ${translateSystemSpeaker(item.task.assignee, tx)}，当前群组为 ${item.task.channel}，优先级 ${translatePriorityLabel(item.task.priority, tx)}${queueText}。`,
      `Assigned to ${translateSystemSpeaker(item.task.assignee, tx)} in ${item.task.channel} with ${translatePriorityLabel(item.task.priority, tx)} priority${queueText}.`,
    );
  }
  if (item.kind === "activity" && item.activity) {
    return renderActivityBody(item.activity, tx);
  }
  return translateSystemSpeaker(item.body, tx);
}

function renderInboxMeta(item: InboxItem, tx: (zh: string, en: string) => string): string {
  if (item.kind === "task" && item.task) {
    const queueText = item.execution ? ` · ${translateQueueStatus(item.execution.queueStatus, tx)}` : "";
    return `${item.task.channel} · ${translatePriorityLabel(item.task.priority, tx)}${queueText}`;
  }
  if (item.kind === "activity") {
    return tx("工作区", "Workspace");
  }
  return translateSystemSpeaker(item.meta, tx);
}

function translateStatusLabel(value: string, tx: (zh: string, en: string) => string): string {
  const task = translateTaskStatus(value, tx);
  if (task) return task;
  const agent = translateAgentStatus(value, tx);
  if (agent) return agent;
  if (value === "System") return tx("系统", "System");
  return value;
}

function translateQueueStatus(value: string, tx: (zh: string, en: string) => string): string {
  return translateQueueStatusValue(value, tx) || value;
}

function translatePriorityLabel(priority: TaskStatus | "low" | "medium" | "high", tx: (zh: string, en: string) => string): string {
  return translatePriority(priority, tx) || String(priority);
}

function renderActivityTitle(
  entry: NonNullable<InboxItem["activity"]>,
  tx: (zh: string, en: string) => string,
): string {
  return translateLedgerTitle(entry, tx);
}

function renderActivityBody(
  entry: NonNullable<InboxItem["activity"]>,
  tx: (zh: string, en: string) => string,
): string {
  return translateLedgerBody(entry, tx);
}

function renderActivityTimestamp(
  entry: NonNullable<InboxItem["activity"]>,
  tx: (zh: string, en: string) => string,
): string {
  return tx("最近", "Recent");
}
