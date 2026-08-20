"use client";

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import MDEditor from "@uiw/react-md-editor/nohighlight";
import type { MessageAttachment, MessageMention } from "@/shared/types/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSystemSpeaker, translateWorkspaceMessageSummary } from "@/features/i18n/presentation";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { EmptyState } from "@/shared/ui/empty-state";
import { FeedbackBanner } from "@/shared/ui/feedback-banner";
import { GeneratedAvatar, type GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import type {
  ConversationListItem,
  ConversationComposerRuntime,
  ConversationMentionCandidate,
  ConversationSlashCommand,
  ConversationThreadMessage,
} from "@/features/chat/conversation-shell";
import type { ExecutionTimelineItem } from "@/features/chat/task-execution-timeline";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";

export const ConversationListRow = memo(function ConversationListRow({
  item,
  selected,
  onSelect,
}: {
  item: ConversationListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`contact-row${selected ? " contact-row--active" : ""}`}
      onClick={() => onSelect(item.id)}
      type="button"
    >
      {item.avatarVariant ? (
        <GeneratedAvatar
          className="contact-row__avatar"
          id={item.avatarId ?? item.id}
          name={item.avatarName ?? item.title}
          variant={item.avatarVariant}
        />
      ) : (
        <div className="contact-row__avatar">{item.avatar}</div>
      )}
      <div className="contact-row__content">
        <div className="contact-row__title">
          <strong>{item.title}</strong>
          <span className="contact-row__title-meta">
            {item.dateLabel ?? ""}
            {item.unread ? <i className="unread-dot" /> : null}
          </span>
        </div>
        <p className="contact-row__preview">{item.meta || item.subtitle}</p>
      </div>
    </button>
  );
});

export function ChatHeader({
  avatar,
  avatarId,
  avatarName,
  avatarVariant,
  title,
  subtitle,
  actions,
  leadingAction,
}: {
  avatar: string;
  avatarId?: string;
  avatarName?: string;
  avatarVariant?: GeneratedAvatarVariant;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  leadingAction?: React.ReactNode;
}) {
  return (
    <header className="contacts-chat-header">
      <div className="contacts-chat-header__main">
        {leadingAction ? <div className="contacts-chat-header__leading">{leadingAction}</div> : null}
        {avatarVariant ? (
          <GeneratedAvatar
            className="contacts-chat-header__avatar"
            id={avatarId ?? title}
            name={avatarName ?? title}
            variant={avatarVariant}
          />
        ) : (
          <div className="contacts-chat-header__avatar">{avatar}</div>
        )}
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

function executionTimelineItemIcon(item: ExecutionTimelineItem): AppIconName | null {
  if (item.kind === "thinking") {
    return "lightbulb";
  }
  if (item.kind === "error") {
    return "alertCircle";
  }
  if (item.kind === "tool") {
    const tool = item.title.toLowerCase();
    if (/\b(bash|shell|terminal|cmd|powershell)\b/.test(tool)) {
      return "terminal";
    }
    if (/\b(grep|search|glob|find|websearch)\b/.test(tool)) {
      return "search";
    }
    return "fileText";
  }
  return null;
}

export function TaskExecutionTimeline({
  items,
  running,
}: {
  items: ExecutionTimelineItem[];
  running?: boolean;
}) {
  // Items start expanded; the set only tracks what the user explicitly collapsed.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  if (items.length === 0) {
    return null;
  }
  const handleToggle = (id: string, open: boolean): void => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (open) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  return (
    <div className={`execution-timeline${running ? " execution-timeline--running" : ""}`}>
      {items.map((item) => {
        if (item.kind === "narration") {
          return (
            <div className="execution-timeline__item execution-timeline__item--narration" key={item.id}>
              <span className="execution-timeline__dot execution-timeline__dot--done" />
              <p className="execution-timeline__narration">{item.title}</p>
            </div>
          );
        }
        const icon = executionTimelineItemIcon(item);
        const heading = (
          <>
            <span
              className={`execution-timeline__dot execution-timeline__dot--${item.status}`}
            >
              {item.status === "running" ? <AppIcon className="execution-timeline__spinner" name="loader" /> : null}
            </span>
            {icon ? <AppIcon className="execution-timeline__icon" name={icon} /> : null}
            <strong className="execution-timeline__title">{item.title}</strong>
            {item.subtitle ? <span className="execution-timeline__subtitle">{item.subtitle}</span> : null}
            {item.detail ? <AppIcon className="execution-timeline__chevron" name="chevronDown" /> : null}
          </>
        );
        if (!item.detail) {
          return (
            <div
              className={`execution-timeline__item execution-timeline__item--${item.kind} execution-timeline__item--static`}
              key={item.id}
            >
              {heading}
            </div>
          );
        }
        return (
          <details
            className={`execution-timeline__item execution-timeline__item--${item.kind}`}
            key={item.id}
            onToggle={(event) => handleToggle(item.id, event.currentTarget.open)}
            open={!collapsedIds.has(item.id)}
          >
            <summary>{heading}</summary>
            <pre className="execution-timeline__detail">{item.detail}</pre>
          </details>
        );
      })}
    </div>
  );
}

function MessageAvatar({
  error,
  role,
  speaker,
  speakerLabel,
  tx,
}: {
  error: boolean;
  role: ConversationThreadMessage["role"];
  speaker: string;
  speakerLabel: string;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <button
      aria-label={tx(`查看 ${speakerLabel} 的信息`, `View ${speakerLabel} details`)}
      className="inbox-bubble-avatar-trigger"
      type="button"
    >
      <GeneratedAvatar
        className={`inbox-bubble-avatar${error ? " inbox-bubble-avatar--error" : ""}`}
        id={`${role}:${speaker}`}
        name={speakerLabel}
        variant={role === "agent" ? "agent" : "human"}
      />
      <span className="inbox-bubble-avatar-tooltip" role="tooltip">
        <strong>{speakerLabel}</strong>
        <small>{role === "agent" ? tx("AI 员工", "AI employee") : tx("成员", "Member")}</small>
      </span>
    </button>
  );
}

function MessageActions({
  acknowledged,
  copied,
  onAcknowledge,
  onCopy,
  onPin,
  onReply,
  onUnpin,
  tx,
}: {
  acknowledged: boolean;
  copied: boolean;
  onAcknowledge?: () => void;
  onCopy: () => void;
  onPin?: () => void;
  onReply?: () => void;
  onUnpin?: () => void;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className="inbox-message-actions">
      {onReply ? (
        <button aria-label={tx("回复", "Reply")} onClick={onReply} title={tx("回复", "Reply")} type="button">
          <AppIcon name="reply" />
        </button>
      ) : null}
      <button
        aria-label={copied ? tx("已复制", "Copied") : tx("复制", "Copy")}
        className={copied ? "is-active" : undefined}
        onClick={onCopy}
        title={copied ? tx("已复制", "Copied") : tx("复制", "Copy")}
        type="button"
      >
        <AppIcon name="copy" />
      </button>
      {onPin ? (
        <button aria-label={tx("置顶", "Pin")} onClick={onPin} title={tx("置顶", "Pin")} type="button">
          <AppIcon name="pin" />
        </button>
      ) : null}
      {onUnpin ? (
        <button aria-label={tx("取消置顶", "Unpin")} onClick={onUnpin} title={tx("取消置顶", "Unpin")} type="button">
          <AppIcon name="pin" />
        </button>
      ) : null}
      {onAcknowledge ? (
        <button
          aria-label={tx("OK，标记已读", "OK, mark as read")}
          className={acknowledged ? "is-active" : undefined}
          onClick={onAcknowledge}
          title={tx("OK，标记已读", "OK, mark as read")}
          type="button"
        >
          <AppIcon name="checkCircle" />
        </button>
      ) : null}
    </div>
  );
}

export const ConversationMessageBubble = memo(function ConversationMessageBubble({
  message,
  isOwn,
  ownSpeakerLabel,
  acknowledgementActorLabel,
  replyToMessage,
  onReply,
  onPin,
  onUnpin,
  onAcknowledge,
  onReviewApproval,
}: {
  message: ConversationThreadMessage;
  isOwn?: boolean;
  ownSpeakerLabel?: string;
  acknowledgementActorLabel?: string;
  replyToMessage?: ConversationThreadMessage;
  onReply?: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onAcknowledge?: () => void;
  onReviewApproval?: (approvalId: string, decision: "approved" | "rejected") => Promise<void> | void;
}) {
  const { tx } = useLanguage();
  const [reviewingDecision, setReviewingDecision] = useState<"approved" | "rejected" | null>(null);
  const [optimisticApproval, setOptimisticApproval] = useState<{
    approvalId: string;
    decision: "approved" | "rejected";
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current);
    }
  }, []);
  const own = isOwn ?? message.role === "human";
  const deliveryStatus = message.deliveryStatus ?? (
    own && message.role === "human" && message.status === "completed" ? "sent" : undefined
  );
  const isPendingMessage = message.status === "pending";
  const hasStreamedPendingContent = isPendingMessage && message.content.trim() !== "" && message.content.trim() !== "Thinking";
  const isError = message.status === "error";
  const isProcessMessage = message.kind === "process";
  const speakerLabel = translateSystemSpeaker(message.speaker, tx);
  const isFeishuMessage = message.data?.external_provider === "feishu";
  const replyToSpeakerLabel = replyToMessage ? translateSystemSpeaker(replyToMessage.speaker, tx) : "";
  const approvalAction = buildRuntimeApprovalAction(message, tx);
  const executionReply = message.executionReply;
  const actionMessage = executionReply ?? message;
  const actionAcknowledgements = actionMessage.acknowledgements ?? [];
  const acknowledgementLabelForCurrentUser = acknowledgementActorLabel ?? ownSpeakerLabel;
  const acknowledgedByCurrentUser = actionAcknowledgements.some((acknowledgement) =>
    acknowledgementLabelForCurrentUser
      ? acknowledgement.label.localeCompare(acknowledgementLabelForCurrentUser, "zh-CN", { sensitivity: "base" }) === 0
      : false,
  );
  useEffect(() => {
    if (
      optimisticApproval &&
      (!approvalAction ||
        approvalAction.approvalId !== optimisticApproval.approvalId ||
        approvalAction.status !== "pending")
    ) {
      setOptimisticApproval(null);
    }
  }, [approvalAction?.approvalId, approvalAction?.status, optimisticApproval]);
  const displayedApprovalAction = approvalAction && optimisticApproval?.approvalId === approvalAction.approvalId
    ? {
        ...approvalAction,
        status: optimisticApproval.decision,
        label: translateInlineApprovalStatus(optimisticApproval.decision, tx),
      }
    : approvalAction;
  const canReviewApproval = Boolean(
    displayedApprovalAction &&
    displayedApprovalAction.status === "pending" &&
    onReviewApproval &&
    !reviewingDecision,
  );
  const pendingStageLabel = resolvePendingStageLabel(message, tx);
  const pendingStageDetail = resolvePendingStageDetail(message, tx);
  const handleCopy = (content: string): void => {
    void copyMessageContent(content).then(() => {
      setCopied(true);
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedResetTimerRef.current = null;
      }, 1600);
    }).catch(() => {});
  };

  if (isProcessMessage) {
    return (
      <div className="inbox-bubble-row" data-conversation-message-id={message.id}>
        <MessageAvatar
          error={isError}
          role={message.role}
          speaker={message.speaker}
          speakerLabel={speakerLabel}
          tx={tx}
        />
        <div className="inbox-message-unit">
          {!message.executionRunning ? (
            <time className="inbox-message-meta">{renderMessageTimestamp(executionReply?.timestamp ?? message.timestamp)}</time>
          ) : null}
          <div className="inbox-message-body">
            {message.execution ? (
              <div
                className={`conversation-process conversation-process--timeline${
                  message.executionRunning ? " conversation-process--pending" : ""
                }${isError ? " conversation-process--error" : ""}`}
              >
                <TaskExecutionTimeline items={message.execution} running={message.executionRunning} />
                {executionReply ? (
                  <div className="conversation-process__reply">
                    <span className="sr-only">{translateSystemSpeaker(executionReply.speaker, tx)}</span>
                    <ChatMessageContent
                      content={translateWorkspaceMessageSummary(executionReply, tx)}
                      mentions={executionReply.mentions}
                      tx={tx}
                    />
                    {executionReply.attachments?.length ? <ChatAttachmentRow attachments={executionReply.attachments} tx={tx} /> : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <details
                className={`conversation-process${message.status === "pending" ? " conversation-process--pending" : ""}${
                  isError ? " conversation-process--error" : ""
                }`}
              >
                <summary>
                  <span className="conversation-process__heading">
                    {message.status === "pending" ? <AppIcon className="conversation-process__spinner" name="loader" /> : null}
                    <strong>{processTitle(message, tx)}</strong>
                  </span>
                  {message.status === "pending" ? (
                    <span aria-live="polite" className="conversation-process__state">{tx("进行中", "In progress")}</span>
                  ) : null}
                </summary>
                <pre>{message.executionDetail ?? message.data?.execution_detail ?? message.content}</pre>
              </details>
            )}
            {executionReply ? (
              <MessageActions
                acknowledged={acknowledgedByCurrentUser}
                copied={copied}
                onAcknowledge={onAcknowledge}
                onCopy={() => handleCopy(executionReply.content)}
                onPin={onPin}
                onReply={onReply}
                onUnpin={onUnpin}
                tx={tx}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const hasActions = message.deliveryStatus === undefined;
  const acknowledgements = message.acknowledgements ?? [];
  const acknowledgementLabel = acknowledgements.map((acknowledgement) => acknowledgement.label).join("、");

  return (
    <div
      className={`inbox-bubble-row${own ? " inbox-bubble-row--own" : ""}${
        message.executionGrouped ? " inbox-bubble-row--execution-reply" : ""
      }`}
      data-conversation-message-id={message.id}
    >
      {!own ? (
        <MessageAvatar
          error={isError}
          role={message.role}
          speaker={message.speaker}
          speakerLabel={speakerLabel}
          tx={tx}
        />
      ) : null}
      <div className="inbox-message-unit">
        {!isPendingMessage ? (
          <div className="inbox-message-meta">
            {isError ? <strong>{tx("错误", "Error")}</strong> : null}
            <time>{renderMessageTimestamp(message.timestamp)}</time>
            {deliveryStatus ? <MessageDeliveryIcon announce={message.deliveryStatus !== undefined} status={deliveryStatus} tx={tx} /> : null}
          </div>
        ) : null}
        <div className="inbox-message-body">
          <article
            className={`inbox-bubble${own ? " inbox-bubble--own" : ""}${isError ? " inbox-bubble--error" : ""}${
              isPendingMessage ? " inbox-bubble--pending" : ""
            }${message.pinned ? " inbox-bubble--pinned" : ""}${
              deliveryStatus ? ` inbox-bubble--delivery-${deliveryStatus}` : ""
            }`}
            tabIndex={hasActions && !isPendingMessage ? 0 : undefined}
          >
            {replyToMessage ? (
              <div className="inbox-bubble__reply-quote">
                <strong>{replyToSpeakerLabel}</strong>
                <span>{replyToMessage.content.slice(0, 80)}{replyToMessage.content.length > 80 ? "..." : ""}</span>
              </div>
            ) : null}
            <span className="sr-only">{own ? ownSpeakerLabel ?? tx("你", "You") : speakerLabel}</span>
        {isPendingMessage ? (
          <div className="inbox-bubble__meta inbox-bubble__meta--status">
            <strong>{pendingStageLabel}</strong>
            <span className="inbox-bubble__delivery-meta" aria-live="polite">
              <MessageDeliveryIcon announce={false} status="sending" tx={tx} />
            </span>
          </div>
        ) : null}
        {isFeishuMessage || message.pinned ? (
          <div className="inbox-bubble__badges">
            {isFeishuMessage ? (
              <span aria-label={tx("来自飞书", "From Feishu")} className="inbox-bubble__provider-icon" role="img">
                <AppIcon name="feishu" />
              </span>
            ) : null}
            {message.pinned ? <span className="inbox-bubble__pin-badge">{tx("已置顶", "Pinned")}</span> : null}
          </div>
        ) : null}
        {isPendingMessage ? (
          hasStreamedPendingContent ? (
            <div className="inbox-bubble__streaming-content">
              <ChatMessageContent content={translateWorkspaceMessageSummary(message, tx)} mentions={message.mentions} tx={tx} />
              <span aria-label={tx("正在生成", "Generating")} className="contacts-pending-dots contacts-pending-dots--inline">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : pendingStageDetail ? (
            <div className="inbox-bubble__streaming-content">
              <span>{pendingStageDetail}</span>
              <span aria-label={tx("正在等待", "Waiting")} className="contacts-pending-dots contacts-pending-dots--inline">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : (
            <div className="contacts-pending-dots">
              <span />
              <span />
              <span />
            </div>
          )
        ) : (
          <ChatMessageContent content={translateWorkspaceMessageSummary(message, tx)} mentions={message.mentions} tx={tx} />
        )}
        {displayedApprovalAction ? (
          <div className={`runtime-approval-card runtime-approval-card--${displayedApprovalAction.status}`}>
            <div className="runtime-approval-card__header">
              <span>{displayedApprovalAction.label}</span>
              <strong>{displayedApprovalAction.toolName}</strong>
            </div>
            <pre>{displayedApprovalAction.preview}</pre>
            {displayedApprovalAction.comment ? <small>{displayedApprovalAction.comment}</small> : null}
            {displayedApprovalAction.status === "pending" && onReviewApproval ? (
              <div className="runtime-approval-card__actions">
                <button
                  className="runtime-approval-card__btn runtime-approval-card__btn--approve"
                  disabled={!canReviewApproval}
                  onClick={() => handleReviewApproval("approved")}
                  type="button"
                >
                  {reviewingDecision === "approved" ? tx("处理中", "Working") : tx("批准", "Approve")}
                </button>
                <button
                  className="runtime-approval-card__btn runtime-approval-card__btn--reject"
                  disabled={!canReviewApproval}
                  onClick={() => handleReviewApproval("rejected")}
                  type="button"
                >
                  {reviewingDecision === "rejected" ? tx("处理中", "Working") : tx("驳回", "Reject")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {documentLinkForMessage(message) ? (
          <Link className="message-inline-link" href={documentLinkForMessage(message)!}>
            {tx("打开文档", "Open document")}
          </Link>
        ) : null}
        {message.attachments?.length ? <ChatAttachmentRow attachments={message.attachments} tx={tx} /> : null}
        {acknowledgements.length > 0 ? (
          <div
            className="inbox-bubble__ack"
            title={tx(`${acknowledgementLabel} 已 OK`, `${acknowledgementLabel} acknowledged`)}
          >
            <span aria-hidden="true">👌</span>
            {acknowledgements.length > 1 ? <small>{acknowledgements.length}</small> : null}
          </div>
        ) : null}
          </article>
          {hasActions && !isPendingMessage ? (
            <MessageActions
              acknowledged={acknowledgedByCurrentUser}
              copied={copied}
              onAcknowledge={onAcknowledge}
              onCopy={() => handleCopy(message.content)}
              onPin={onPin}
              onReply={onReply}
              onUnpin={onUnpin}
              tx={tx}
            />
          ) : null}
        </div>
      </div>
    </div>
  );

  function handleReviewApproval(decision: "approved" | "rejected"): void {
    if (!approvalAction || !onReviewApproval || reviewingDecision) {
      return;
    }
    setReviewingDecision(decision);
    void Promise.resolve()
      .then(() => onReviewApproval(approvalAction.approvalId, decision))
      .then(() => {
        setOptimisticApproval({ approvalId: approvalAction.approvalId, decision });
        setReviewingDecision(null);
      })
      .catch(() => {
        setReviewingDecision(null);
      });
  }

});

function MessageDeliveryIcon({
  announce,
  status,
  tx,
}: {
  announce: boolean;
  status: "sending" | "sent" | "failed";
  tx: (zh: string, en: string) => string;
}) {
  const label = status === "sending"
    ? tx("正在发送", "Sending")
    : status === "sent"
      ? tx("已发送", "Sent")
      : tx("发送失败", "Failed to send");
  const iconName = status === "sending" ? "loader" : status === "sent" ? "checkCircle" : "alertCircle";

  return (
    <span
      aria-label={label}
      className={`inbox-bubble__delivery-icon inbox-bubble__delivery-icon--${status}`}
      role={announce ? "status" : "img"}
      title={label}
    >
      <AppIcon name={iconName} />
    </span>
  );
}

function resolvePendingStageLabel(
  message: ConversationThreadMessage,
  tx: (zh: string, en: string) => string,
): string {
  if (message.data?.task_queue_status === "queued") {
    return message.data.task_queue_delayed === "true"
      ? tx("等待执行节点", "Waiting for runtime")
      : tx("排队中", "Queued");
  }
  if (message.data?.task_queue_status === "claimed") {
    return tx("准备中", "Preparing");
  }
  return tx("思考中", "Thinking");
}

function resolvePendingStageDetail(
  message: ConversationThreadMessage,
  tx: (zh: string, en: string) => string,
): string | undefined {
  if (message.data?.task_queue_status === "queued") {
    return message.data.task_queue_delayed === "true"
      ? tx("执行节点响应较慢，任务仍在队列中", "The runtime is responding slowly; the task is still queued")
      : tx("等待执行节点领取任务", "Waiting for the runtime to claim this task");
  }
  if (message.data?.task_queue_status === "claimed") {
    return tx("执行节点已领取，正在准备环境", "The runtime claimed this task and is preparing the environment");
  }
  return undefined;
}

async function copyMessageContent(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard access is unavailable.");
  }
}

function renderMessageTimestamp(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}

function buildRuntimeApprovalAction(
  message: ConversationThreadMessage,
  tx: (zh: string, en: string) => string,
): {
  approvalId: string;
  status: "pending" | "approved" | "rejected" | "revised";
  toolName: string;
  preview: string;
  label: string;
  comment?: string;
} | null {
  if (message.code !== "approval.created" || message.data?.approval_type !== "runtime_tool") {
    return null;
  }
  const approvalId = message.data.approval_id?.trim();
  if (!approvalId) {
    return null;
  }
  const status = normalizeApprovalStatus(message.data.approval_status);
  return {
    approvalId,
    status,
    toolName: message.data.tool_name?.trim() || tx("工具调用", "Tool call"),
    preview: message.data.content_preview?.trim() || message.content,
    label: translateInlineApprovalStatus(status, tx),
    comment: message.data.reviewer_comment?.trim() || undefined,
  };
}

function normalizeApprovalStatus(value?: string): "pending" | "approved" | "rejected" | "revised" {
  if (value === "approved" || value === "rejected" || value === "revised") {
    return value;
  }
  return "pending";
}

function translateInlineApprovalStatus(
  status: "pending" | "approved" | "rejected" | "revised",
  tx: (zh: string, en: string) => string,
): string {
  if (status === "approved") {
    return tx("已批准", "Approved");
  }
  if (status === "rejected") {
    return tx("已驳回", "Rejected");
  }
  if (status === "revised") {
    return tx("已修改", "Revised");
  }
  return tx("等待审批", "Waiting for approval");
}

function processTitle(message: ConversationThreadMessage, tx: (zh: string, en: string) => string): string {
  if (message.processType === "thinking") {
    return message.status === "pending" ? tx("正在分析任务", "Analyzing task") : tx("已完成分析", "Analysis complete");
  }
  if (message.processType === "tool_use") {
    const label = message.status === "pending" ? tx("正在调用工具", "Using tool") : tx("已调用工具", "Tool used");
    return message.tool ? `${label} · ${message.tool}` : label;
  }
  if (message.processType === "tool_result") {
    return message.tool ? `${tx("工具已完成", "Tool complete")} · ${message.tool}` : tx("工具已完成", "Tool complete");
  }
  if (message.processType === "status") {
    return message.content || tx("状态更新", "Status update");
  }
  return message.processType ?? tx("中间过程", "Process");
}

type ChatTranslator = (zh: string, en: string) => string;

export function ChatAttachmentRow({
  attachments,
  tx = defaultChatTranslator,
}: {
  attachments: MessageAttachment[];
  tx?: ChatTranslator;
}) {
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div className="chat-attachments">
      {images.length > 0 ? (
        <div className="chat-attachments__images">
          {images.map((attachment) => (
            <AttachmentImageCard
              attachment={attachment}
              key={attachment.id}
              onPreview={() => setPreviewAttachment(attachment)}
              previewLabel={tx(`预览 ${attachment.fileName}`, `Preview ${attachment.fileName}`)}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="chat-attachments__files">
          {files.map((attachment) => (
            <AttachmentFileCard
              attachment={attachment}
              key={attachment.id}
              onPreview={() => setPreviewAttachment(attachment)}
              previewLabel={tx(`预览 ${attachment.fileName}`, `Preview ${attachment.fileName}`)}
            />
          ))}
        </div>
      ) : null}
      {previewAttachment ? (
        <AttachmentPreviewDialog
          downloadHref={attachmentHref(previewAttachment)}
          fileName={previewAttachment.fileName}
          mediaType={previewAttachment.mediaType}
          onClose={() => setPreviewAttachment(null)}
          previewHref={attachmentHref(previewAttachment, true)}
          tx={tx}
        />
      ) : null}
    </div>
  );
}

function attachmentHref(attachment: MessageAttachment, preview = false): string {
  if (attachment.localPreviewUrl) return attachment.localPreviewUrl;
  return `/api/attachments/${attachment.id}${preview ? "?preview=1" : ""}`;
}

function AttachmentImageCard({
  attachment,
  onPreview,
  previewLabel,
}: {
  attachment: MessageAttachment;
  onPreview: () => void;
  previewLabel: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <AttachmentFileCard
        attachment={attachment}
        onPreview={onPreview}
        previewLabel={previewLabel}
      />
    );
  }

  return (
    <button
      aria-label={previewLabel}
      className="chat-attachment-image"
      onClick={onPreview}
      type="button"
    >
      {!loaded ? <span aria-hidden="true" className="chat-attachment-image__loading" /> : null}
      <img
        alt={attachment.fileName}
        className={`chat-attachment-image__img${loaded ? " chat-attachment-image__img--ready" : ""}`}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        src={attachmentHref(attachment)}
      />
    </button>
  );
}

function AttachmentFileCard({
  attachment,
  onPreview,
  previewLabel,
}: {
  attachment: MessageAttachment;
  onPreview: () => void;
  previewLabel: string;
}) {
  return (
    <button
      aria-label={previewLabel}
      className="chat-attachment-file"
      onClick={onPreview}
      type="button"
    >
      <span className="chat-attachment-file__icon">
        {fileIcon(attachment.mediaType, attachment.kind)}
      </span>
      <span className="chat-attachment-file__info">
        <strong>{attachment.fileName}</strong>
        <small>{formatFileSize(attachment.sizeBytes)}</small>
      </span>
    </button>
  );
}

function fileIcon(mediaType: string, kind?: MessageAttachment["kind"]): string {
  if (kind === "image") return "IMG";
  if (mediaType.startsWith("text/")) return "TXT";
  if (mediaType.includes("pdf")) return "PDF";
  if (mediaType.includes("zip") || mediaType.includes("tar") || mediaType.includes("gz")) return "ZIP";
  if (mediaType.includes("json")) return "{ }";
  return "FILE";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatComposer({
  caretIndex,
  draft,
  executionPolicy,
  executionPolicyPending = false,
  feedback,
  files,
  isPending,
  mentionSuggestions,
  references,
  runtime,
  slashSuggestions,
  placeholder,
  showPicker,
  pickerRef,
  mediaInputRef,
  fileInputRef,
  folderInputRef,
  textareaRef,
  onDraftChange,
  onInsertMentionTrigger,
  onTogglePicker,
  onPickedFiles,
  onRemoveFile,
  onRemoveReference,
  onSelectMention,
  onSelectSlashCommand,
  onSelectExecutionPolicy,
  onSubmit,
  replyToMessage,
  onCancelReply,
  isAgentRunning = false,
  queuedMessages = [],
  onClearQueue,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onStop,
  showExecutionPolicyMenu = false,
  onToggleExecutionPolicyMenu,
}: {
  caretIndex: number;
  draft: string;
  executionPolicy?: EmployeeExecutionPolicy;
  executionPolicyPending?: boolean;
  feedback: string | null;
  files: Array<{ id: string; label: string; file: File }>;
  isPending: boolean;
  mentionSuggestions: ConversationMentionCandidate[];
  references: Array<{ id: string; label: string; kind: "file" | "skill" }>;
  runtime?: ConversationComposerRuntime;
  slashSuggestions: ConversationSlashCommand[];
  placeholder: string;
  showPicker: boolean;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  mediaInputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string, caretIndex: number) => void;
  onInsertMentionTrigger: () => void;
  onTogglePicker: () => void;
  onPickedFiles: (files: FileList | File[] | null) => void;
  onRemoveFile: (id: string) => void;
  onRemoveReference: (id: string) => void;
  onSelectMention: (candidate: ConversationMentionCandidate) => void;
  onSelectSlashCommand: (command: ConversationSlashCommand) => void;
  onSelectExecutionPolicy?: (policy?: EmployeeExecutionPolicy) => void;
  onSubmit: () => void;
  replyToMessage?: ConversationThreadMessage | null;
  onCancelReply?: () => void;
  isAgentRunning?: boolean;
  queuedMessages?: Array<{
    id: string;
    content: string;
    createdAt: string;
  }>;
  onClearQueue?: () => void;
  onDeleteQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, content: string) => void;
  onGuideQueuedMessage?: (id: string) => void;
  onStop?: () => void;
  showExecutionPolicyMenu?: boolean;
  onToggleExecutionPolicyMenu?: () => void;
}) {
  const { tx } = useLanguage();
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueValue, setEditingQueueValue] = useState("");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const executionPolicyRef = useRef<HTMLDivElement>(null);
  const executionPolicyTriggerRef = useRef<HTMLButtonElement>(null);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const hasDraft = draft.trim().length > 0 || files.length > 0 || references.length > 0;
  const displayedFeedback = feedback;
  const isStopAction = isAgentRunning && !hasDraft;
  const activeSuggestions = slashSuggestions.length > 0 ? slashSuggestions : mentionSuggestions;
  const slashMenuOpen = slashSuggestions.length > 0 && !suggestionsDismissed;
  const mentionMenuOpen = !slashMenuOpen && mentionSuggestions.length > 0 && !suggestionsDismissed;
  const executionOptions = useMemo(() => buildExecutionPolicyOptions(runtime, tx), [runtime, tx]);
  const selectedExecutionOption = executionOptions.find((option) => option.id === executionPolicySelection(runtime, executionPolicy))
    ?? executionOptions[0];

  useEffect(() => {
    setActiveSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [caretIndex, draft]);

  useEffect(() => {
    if (activeSuggestionIndex >= activeSuggestions.length) {
      setActiveSuggestionIndex(0);
    }
  }, [activeSuggestionIndex, activeSuggestions.length]);

  useEffect(() => {
    if (!showExecutionPolicyMenu || !onToggleExecutionPolicyMenu) {
      return;
    }
    function handlePointerDown(event: MouseEvent): void {
      if (!executionPolicyRef.current?.contains(event.target as Node)) {
        onToggleExecutionPolicyMenu?.();
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onToggleExecutionPolicyMenu?.();
        executionPolicyTriggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onToggleExecutionPolicyMenu, showExecutionPolicyMenu]);

  useEffect(() => {
    if (!showPicker) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pickerMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onTogglePicker();
        pickerTriggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onTogglePicker, showPicker]);

  function handlePickerMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(
      pickerMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [],
    );
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function beginQueueEdit(id: string, content: string): void {
    setEditingQueueId(id);
    setEditingQueueValue(content);
  }

  function commitQueueEdit(): void {
    if (!editingQueueId || !editingQueueValue.trim()) {
      return;
    }
    onEditQueuedMessage?.(editingQueueId, editingQueueValue.trim());
    setEditingQueueId(null);
    setEditingQueueValue("");
  }

  return (
    <div className="inbox-composer">
      {displayedFeedback ? <FeedbackBanner feedback={{ tone: "error", message: displayedFeedback }} /> : null}
      {queuedMessages.length > 0 ? (
        <section aria-label={tx("消息队列", "Message queue")} className="conversation-message-queue">
          <div className="conversation-message-queue__header">
            <div>
              <strong>{tx("消息队列", "Message queue")}</strong>
              <span>{tx(`${queuedMessages.length} 条待处理`, `${queuedMessages.length} queued`)}</span>
            </div>
            {onClearQueue ? (
              <button
                aria-label={tx("关闭并清空消息队列", "Close and clear message queue")}
                className="conversation-message-queue__clear"
                onClick={onClearQueue}
                title={tx("关闭排队", "Close queue")}
                type="button"
              >
                <AppIcon name="close" />
              </button>
            ) : null}
          </div>
          <div className="conversation-message-queue__list">
            {queuedMessages.map((message, index) => (
              <article className="conversation-message-queue__item" key={message.id}>
                <span aria-hidden="true" className="conversation-message-queue__handle">{index + 1}</span>
                {editingQueueId === message.id ? (
                  <div className="conversation-message-queue__editor">
                    <textarea
                      aria-label={tx("编辑排队消息", "Edit queued message")}
                      autoFocus
                      onChange={(event) => setEditingQueueValue(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setEditingQueueId(null);
                          setEditingQueueValue("");
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          commitQueueEdit();
                        }
                      }}
                      rows={2}
                      value={editingQueueValue}
                    />
                    <div className="conversation-message-queue__editor-actions">
                      <button onClick={() => setEditingQueueId(null)} type="button">
                        {tx("取消", "Cancel")}
                      </button>
                      <button disabled={!editingQueueValue.trim()} onClick={commitQueueEdit} type="button">
                        {tx("保存", "Save")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>{message.content}</p>
                )}
                <div className="conversation-message-queue__actions">
                  {onGuideQueuedMessage ? (
                    <button
                      aria-label={tx(`立即引导：${message.content}`, `Steer now: ${message.content}`)}
                      className="conversation-message-queue__guide"
                      disabled={isPending}
                      onClick={() => onGuideQueuedMessage(message.id)}
                      type="button"
                    >
                      <AppIcon name="send" />
                      <span>{tx("引导", "Steer")}</span>
                    </button>
                  ) : null}
                  {onEditQueuedMessage ? (
                    <button
                      aria-label={tx("编辑消息", "Edit message")}
                      onClick={() => beginQueueEdit(message.id, message.content)}
                      title={tx("编辑消息", "Edit message")}
                      type="button"
                    >
                      <AppIcon name="edit" />
                    </button>
                  ) : null}
                  {onDeleteQueuedMessage ? (
                    <button
                      aria-label={tx("删除排队消息", "Delete queued message")}
                      onClick={() => onDeleteQueuedMessage(message.id)}
                      title={tx("删除", "Delete")}
                      type="button"
                    >
                      <AppIcon name="trash" />
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {replyToMessage ? (
        <div className="composer-reply-preview">
          <div className="composer-reply-preview__content">
            <strong>{translateSystemSpeaker(replyToMessage.speaker, tx)}</strong>
            <span>{replyToMessage.content.slice(0, 100)}{replyToMessage.content.length > 100 ? "..." : ""}</span>
          </div>
          {onCancelReply ? (
            <button
              aria-label={tx("取消回复", "Cancel reply")}
              className="composer-reply-preview__cancel"
              onClick={onCancelReply}
              type="button"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      {files.length > 0 || references.length > 0 ? (
        <div className="contacts-attachments">
          {files.map((item) => (
            <PendingAttachmentCard item={item} key={item.id} onRemove={() => onRemoveFile(item.id)} />
          ))}
          {references.map((item) => (
            <span className={`contacts-attachment-chip contacts-attachment-chip--${item.kind}`} key={item.id}>
              <AppIcon name={item.kind === "skill" ? "skills" : "knowledge"} />
              <span>{item.label}</span>
              <button
                aria-label={tx(`移除引用 ${item.label}`, `Remove reference ${item.label}`)}
                className="contacts-attachment-remove"
                onClick={() => onRemoveReference(item.id)}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

        <textarea
          className="contacts-composer__textarea"
          onChange={(event) => onDraftChange(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onPaste={(event) => {
            const pastedFiles = filesFromClipboard(event.clipboardData);
            if (pastedFiles.length === 0) {
              return;
            }
            event.preventDefault();
            onPickedFiles(pastedFiles);
          }}
          onKeyDown={(event) => {
            const nativeEvent = event.nativeEvent as KeyboardEvent;
            if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
              return;
            }

            const suggestionMenuOpen = slashMenuOpen || mentionMenuOpen;
            if (suggestionMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActiveSuggestionIndex((current) => {
                const direction = event.key === "ArrowDown" ? 1 : -1;
                return (current + direction + activeSuggestions.length) % activeSuggestions.length;
              });
              return;
            }
            if (suggestionMenuOpen && event.key === "Escape") {
              event.preventDefault();
              setSuggestionsDismissed(true);
              return;
            }
            if (suggestionMenuOpen && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const selected = activeSuggestions[activeSuggestionIndex];
              if (selected) {
                if (slashMenuOpen) {
                  onSelectSlashCommand(selected as ConversationSlashCommand);
                } else {
                  onSelectMention(selected as ConversationMentionCandidate);
                }
              }
              return;
            }

            if (event.key !== "Enter" || event.shiftKey) {
              return;
            }

            event.preventDefault();
            onSubmit();
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={3}
          value={draft}
        />

        {mentionMenuOpen ? (
          <div aria-label={tx("引用建议", "Reference suggestions")} className="contacts-mention-menu contacts-composer-menu" role="listbox">
            {mentionSuggestions.map((candidate) => (
              <button
                aria-selected={mentionSuggestions.indexOf(candidate) === activeSuggestionIndex}
                className={`contacts-mention-item${mentionSuggestions.indexOf(candidate) === activeSuggestionIndex ? " contacts-mention-item--active" : ""}`}
                key={candidate.id}
                onClick={() => onSelectMention(candidate)}
                role="option"
                type="button"
              >
                <div>
                  <strong>{candidate.label}</strong>
                  <span>{candidate.subtitle}</span>
                </div>
                <small>{formatMentionCandidateScope(candidate, tx)}</small>
              </button>
            ))}
          </div>
        ) : null}

        {slashMenuOpen ? (
          <div aria-label={tx("快捷指令", "Slash commands")} className="contacts-command-menu contacts-composer-menu" role="listbox">
            <div className="contacts-composer-menu__heading">{tx("快捷指令", "Commands")}</div>
            {slashSuggestions.map((command, index) => (
              <button
                aria-selected={index === activeSuggestionIndex}
                className={`contacts-command-item${index === activeSuggestionIndex ? " contacts-command-item--active" : ""}`}
                key={command.id}
                onClick={() => onSelectSlashCommand(command)}
                role="option"
                type="button"
              >
                <code>{command.command}</code>
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="contacts-composer__footer">
          <div className="contacts-composer__tools">
            <button
              aria-label={tx("插入 @ 提及", "Insert @ mention")}
              className="contacts-tool-button"
              onClick={onInsertMentionTrigger}
              type="button"
            >
              <AppIcon name="atSign" />
            </button>
            <button
              aria-label={tx("剪贴内容（暂未启用）", "Clip content (not available yet)")}
              className="contacts-tool-button"
              disabled
              type="button"
            >
              <AppIcon name="scissors" />
            </button>
            <div className="contacts-picker-wrap" ref={pickerRef}>
              <button
                aria-expanded={showPicker}
                aria-haspopup="menu"
                aria-label={tx("打开附件与快捷内容菜单", "Open attachments and quick content menu")}
                className="contacts-picker-trigger"
                onClick={onTogglePicker}
                ref={pickerTriggerRef}
                type="button"
              >
                <AppIcon name="plus" />
              </button>
              {showPicker ? (
                <div
                  aria-label={tx("附件与快捷内容", "Attachments and quick content")}
                  className="contacts-picker-menu"
                  onKeyDown={handlePickerMenuKeyDown}
                  ref={pickerMenuRef}
                  role="menu"
                >
                  <button className="contacts-picker-item" onClick={onInsertMentionTrigger} role="menuitem" type="button">
                    <span className="contacts-picker-item__icon"><AppIcon name="atSign" /></span>
                    <span>{tx("引用成员、文件或技能", "Reference people, files, or skills")}</span>
                  </button>
                  <div className="contacts-picker-divider" />
                  <button className="contacts-picker-item" onClick={() => mediaInputRef.current?.click()} role="menuitem" type="button">
                    <span className="contacts-picker-item__icon"><AppIcon name="open" /></span>
                    <span>{tx("图片/视频", "Images / Videos")}</span>
                  </button>
                  <button className="contacts-picker-item" onClick={() => fileInputRef.current?.click()} role="menuitem" type="button">
                    <span className="contacts-picker-item__icon"><AppIcon name="knowledge" /></span>
                    <span>{tx("本地文件", "Local files")}</span>
                  </button>
                  <button className="contacts-picker-item" onClick={() => folderInputRef.current?.click()} role="menuitem" type="button">
                    <span className="contacts-picker-item__icon"><AppIcon name="templates" /></span>
                    <span>{tx("本地文件夹", "Local folder")}</span>
                  </button>
                </div>
              ) : null}
              <input
                accept="image/*,video/*"
                hidden
                multiple
                onChange={(event) => onPickedFiles(event.currentTarget.files)}
                ref={mediaInputRef}
                type="file"
              />
              <input
                hidden
                multiple
                onChange={(event) => onPickedFiles(event.currentTarget.files)}
                ref={fileInputRef}
                type="file"
              />
              <input
                hidden
                multiple
                onChange={(event) => onPickedFiles(event.currentTarget.files)}
                ref={folderInputRef}
                // @ts-expect-error webkitdirectory is not in React typings
                webkitdirectory=""
                type="file"
              />
            </div>
          </div>

          {runtime && onSelectExecutionPolicy && selectedExecutionOption ? (
            <div className="contacts-execution-policy" ref={executionPolicyRef}>
              <button
                aria-expanded={showExecutionPolicyMenu}
                aria-haspopup="listbox"
                className={`contacts-execution-policy__trigger${selectedExecutionOption.warning ? " contacts-execution-policy__trigger--warning" : ""}`}
                disabled={executionPolicyPending}
                onClick={onToggleExecutionPolicyMenu}
                ref={executionPolicyTriggerRef}
                title={tx("执行权限", "Execution permissions")}
                type="button"
              >
                <AppIcon className={executionPolicyPending ? "contacts-send-button__spinner" : undefined} name={executionPolicyPending ? "loader" : "approvals"} />
                <span>{selectedExecutionOption.label}</span>
                <AppIcon name="chevronDown" />
              </button>
              {showExecutionPolicyMenu ? (
                <div aria-label={tx("执行权限", "Execution permissions")} className="contacts-execution-policy__menu" role="listbox">
                  <div className="contacts-composer-menu__heading">
                    {runtime.provider === "claude" ? "Claude Code" : "Codex"} · {tx("执行权限", "Execution permissions")}
                  </div>
                  {executionOptions.map((option) => (
                    <button
                      aria-selected={option.id === selectedExecutionOption.id}
                      className={`contacts-execution-policy__option${option.id === selectedExecutionOption.id ? " contacts-execution-policy__option--selected" : ""}${option.warning ? " contacts-execution-policy__option--warning" : ""}`}
                      key={option.id}
                      onClick={() => {
                        onSelectExecutionPolicy(option.policy);
                        executionPolicyTriggerRef.current?.focus({ preventScroll: true });
                      }}
                      role="option"
                      type="button"
                    >
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      {option.id === selectedExecutionOption.id ? <AppIcon name="checkCircle" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            aria-label={
              isStopAction
                ? tx("停止执行", "Stop execution")
                : isAgentRunning
                  ? tx("加入消息队列", "Add to message queue")
                  : tx("发送消息", "Send message")
            }
            className={`contacts-send-button${isStopAction ? " contacts-send-button--stop" : ""}`}
            disabled={isPending || (isStopAction ? !onStop : !hasDraft)}
            onClick={isStopAction ? onStop : onSubmit}
            title={isStopAction ? tx("停止当前执行", "Stop current execution") : undefined}
            type="button"
          >
            <AppIcon
              className={isPending ? "contacts-send-button__spinner" : undefined}
              name={isPending ? "loader" : isStopAction ? "stop" : "send"}
            />
          </button>
        </div>
    </div>
  );
}

function PendingAttachmentCard({
  item,
  onRemove,
}: {
  item: { id: string; label: string; file: File };
  onRemove: () => void;
}) {
  const { tx } = useLanguage();
  const objectUrl = useFileObjectUrl(item.file);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = item.file.type.startsWith("image/");

  return (
    <article className={`composer-attachment-card${isImage ? " composer-attachment-card--image" : ""}`}>
      <button
        aria-label={tx(`预览 ${item.label}`, `Preview ${item.label}`)}
        className="composer-attachment-card__preview"
        onClick={() => setPreviewOpen(true)}
        type="button"
      >
        {isImage && objectUrl ? (
          <img alt={item.label} src={objectUrl} />
        ) : (
          <span className="composer-attachment-card__file-icon">
            {fileIcon(item.file.type, isImage ? "image" : "file")}
          </span>
        )}
        <span className="composer-attachment-card__info">
          <strong>{item.label}</strong>
          <small>{formatFileSize(item.file.size)}</small>
        </span>
      </button>
      <button
        aria-label={tx(`移除 ${item.label}`, `Remove ${item.label}`)}
        className="composer-attachment-card__remove"
        onClick={onRemove}
        title={tx("移除", "Remove")}
        type="button"
      >
        <AppIcon name="close" />
      </button>
      {previewOpen && objectUrl ? (
        <AttachmentPreviewDialog
          downloadHref={objectUrl}
          fileName={item.label}
          mediaType={item.file.type}
          onClose={() => setPreviewOpen(false)}
          previewHref={objectUrl}
          tx={tx}
        />
      ) : null}
    </article>
  );
}

function AttachmentPreviewDialog({
  downloadHref,
  fileName,
  mediaType,
  onClose,
  previewHref,
  tx,
}: {
  downloadHref: string;
  fileName: string;
  mediaType: string;
  onClose: () => void;
  previewHref: string;
  tx: ChatTranslator;
}) {
  const { surfaceRef, handleBackdropMouseDown } = useDialogSurface<HTMLDivElement>(onClose);
  const previewLabel = tx(`预览 ${fileName}`, `Preview ${fileName}`);
  const previewKind = browserPreviewKind(mediaType);

  return (
    <div className="attachment-preview" onMouseDown={handleBackdropMouseDown}>
      <div
        aria-label={previewLabel}
        aria-modal="true"
        className="attachment-preview__dialog"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="attachment-preview__header">
          <div>
            <strong>{fileName}</strong>
            <span>{mediaType || tx("未知文件类型", "Unknown file type")}</span>
          </div>
          <div className="attachment-preview__actions">
            <a
              aria-label={tx(`下载 ${fileName}`, `Download ${fileName}`)}
              download={fileName}
              href={downloadHref}
              title={tx("下载", "Download")}
            >
              <AppIcon name="download" />
            </a>
            <button
              aria-label={tx("关闭预览", "Close preview")}
              onClick={onClose}
              title={tx("关闭", "Close")}
              type="button"
            >
              <AppIcon name="close" />
            </button>
          </div>
        </header>
        <div className="attachment-preview__body">
          {previewKind === "image" ? <img alt={fileName} src={previewHref} /> : null}
          {previewKind === "video" ? <video controls src={previewHref} /> : null}
          {previewKind === "audio" ? <audio controls src={previewHref} /> : null}
          {previewKind === "document" ? (
            <iframe sandbox="" src={previewHref} title={fileName} />
          ) : null}
          {previewKind === "unsupported" ? (
            <div className="attachment-preview__unsupported">
              <AppIcon name="fileText" />
              <strong>{tx("此文件暂不支持在线预览", "This file cannot be previewed here")}</strong>
              <span>{tx("可以下载后使用本地应用打开。", "Download it to open with a local application.")}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function defaultChatTranslator(zh: string): string {
  return zh;
}

function filesFromClipboard(clipboardData: DataTransfer): File[] {
  const files = Array.from(clipboardData.files);
  if (files.length > 0) {
    return files;
  }

  return Array.from(clipboardData.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function useFileObjectUrl(file: File): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const nextObjectUrl = URL.createObjectURL(file);
    setObjectUrl(nextObjectUrl);
    return () => URL.revokeObjectURL(nextObjectUrl);
  }, [file]);

  return objectUrl;
}

function browserPreviewKind(mediaType: string): "image" | "video" | "audio" | "document" | "unsupported" {
  const normalized = mediaType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (
    normalized === "application/pdf" ||
    normalized === "application/json" ||
    normalized.startsWith("text/")
  ) {
    return "document";
  }
  return "unsupported";
}

export function ChatEmptyState({ title, body }: { title: string; body: string }) {
  return <EmptyState body={body} title={title} />;
}

function ChatMessageContent({
  content,
  mentions,
  tx,
}: {
  content: string;
  mentions: MessageMention[] | undefined;
  tx: (zh: string, en: string) => string;
}) {
  if (containsMarkdown(content)) {
    return <MDEditor.Markdown prefixCls="chat-message-markdown" skipHtml source={content} />;
  }

  return <p>{renderMessageContent(content, mentions, tx)}</p>;
}

function containsMarkdown(content: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>|```)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/m.test(content);
}

function renderMessageContent(content: string, mentions: MessageMention[] | undefined, tx: (zh: string, en: string) => string): React.ReactNode {
  if (!mentions || mentions.length === 0) {
    return content;
  }

  const orderedMentions = [...mentions].sort((left, right) => right.token.length - left.token.length);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  const lowerContent = content.toLocaleLowerCase("zh-CN");

  while (cursor < content.length) {
    let nextMatch:
      | {
          mention: MessageMention;
          index: number;
        }
      | undefined;

    for (const mention of orderedMentions) {
      const needle = `@${mention.token}`.toLocaleLowerCase("zh-CN");
      const index = lowerContent.indexOf(needle, cursor);
      if (index < 0) {
        continue;
      }
      if (!nextMatch || index < nextMatch.index || (index === nextMatch.index && mention.token.length > nextMatch.mention.token.length)) {
        nextMatch = { mention, index };
      }
    }

    if (!nextMatch) {
      nodes.push(content.slice(cursor));
      break;
    }

    if (nextMatch.index > cursor) {
      nodes.push(content.slice(cursor, nextMatch.index));
    }

    nodes.push(
      <span
        className="message-mention"
        data-mention-type={nextMatch.mention.mentionType}
        key={`${getMentionKey(nextMatch.mention)}-${nextMatch.index}`}
        title={formatMentionTitle(nextMatch.mention, tx)}
      >
        {content.slice(nextMatch.index, nextMatch.index + nextMatch.mention.token.length + 1)}
      </span>,
    );
    cursor = nextMatch.index + nextMatch.mention.token.length + 1;
  }

  return <>{nodes}</>;
}

function formatMentionCandidateScope(
  candidate: ConversationMentionCandidate,
  tx: (zh: string, en: string) => string,
): string {
  if (candidate.kind === "file") {
    return tx("文件", "File");
  }
  if (candidate.kind === "skill") {
    return tx("技能", "Skill");
  }
  if (candidate.kind === "human") {
    return candidate.inChannel ? tx("群成员", "Member") : tx("其他成员", "Other member");
  }
  return candidate.inChannel ? tx("AI员工", "AI employee") : tx("其他 AI员工", "Other AI employee");
}

interface ComposerExecutionPolicyOption {
  id: string;
  label: string;
  description: string;
  policy?: EmployeeExecutionPolicy;
  warning?: boolean;
}

function buildExecutionPolicyOptions(
  runtime: ConversationComposerRuntime | undefined,
  tx: (zh: string, en: string) => string,
): ComposerExecutionPolicyOption[] {
  if (!runtime) {
    return [];
  }
  const inherit: ComposerExecutionPolicyOption = {
    id: "inherit",
    label: tx("Runtime 默认", "Runtime default"),
    description: tx("使用执行引擎的默认权限", "Use the runtime's default permissions"),
  };
  if (runtime.provider === "claude") {
    return [
      inherit,
      { id: "manual", label: "Manual", description: tx("工具调用需要手动确认", "Confirm tool calls manually"), policy: { claudePermissionMode: "manual" } },
      { id: "acceptEdits", label: "Edit automatically", description: tx("自动接受文件编辑", "Automatically accept file edits"), policy: { claudePermissionMode: "acceptEdits" } },
      { id: "plan", label: "Plan", description: tx("仅规划，不直接修改文件", "Plan without directly editing files"), policy: { claudePermissionMode: "plan" } },
      { id: "auto", label: "Auto", description: tx("由 Claude Code 自动处理权限", "Let Claude Code handle permissions automatically"), policy: { claudePermissionMode: "auto" } },
    ];
  }
  return [
    inherit,
    {
      id: "untrusted",
      label: tx("请求批准", "Request approval"),
      description: tx("敏感操作始终请求批准", "Always request approval for sensitive operations"),
      policy: { codexApprovalPolicy: "untrusted", codexSandboxMode: "workspace-write" },
    },
    {
      id: "on-request",
      label: tx("帮我审批", "Ask me when needed"),
      description: tx("仅在 Codex 判断有需要时请求", "Ask only when Codex determines it is needed"),
      policy: { codexApprovalPolicy: "on-request", codexSandboxMode: "workspace-write" },
    },
    {
      id: "full-access",
      label: tx("完全访问", "Full access"),
      description: tx("跳过审批与沙箱限制", "Bypass approvals and sandbox restrictions"),
      policy: { codexApprovalPolicy: "never", codexSandboxMode: "danger-full-access" },
      warning: true,
    },
  ];
}

function executionPolicySelection(
  runtime: ConversationComposerRuntime | undefined,
  policy: EmployeeExecutionPolicy | undefined,
): string {
  if (!runtime || !policy) {
    return "inherit";
  }
  if (runtime.provider === "claude") {
    return policy.claudePermissionMode ?? "inherit";
  }
  if (policy.codexSandboxMode === "danger-full-access" || policy.codexApprovalPolicy === "never") {
    return "full-access";
  }
  return policy.codexApprovalPolicy === "on-request" ? "on-request" : policy.codexApprovalPolicy === "untrusted" ? "untrusted" : "inherit";
}

function getMentionKey(mention: MessageMention): string {
  return mention.mentionType === "human" ? mention.humanId : mention.agentId;
}

function formatMentionTitle(mention: MessageMention, tx: (zh: string, en: string) => string): string {
  return mention.mentionType === "human"
    ? tx(`人类提及：${mention.label}`, `Human mention: ${mention.label}`)
    : tx(`AI员工提及：${mention.label}`, `AI employee mention: ${mention.label}`);
}

function documentLinkForMessage(message: ConversationThreadMessage): string | null {
  const documentId = message.data?.document_id;
  const channelName = message.data?.channel_name;
  if (!documentId || !channelName) {
    return null;
  }
  if (
    message.code !== "channel_document.created_notice" &&
    message.code !== "channel_document.updated_notice" &&
    message.code !== "channel_document.archived_notice"
  ) {
    return null;
  }
  return `/im?focus=${encodeURIComponent(`channel-${channelName}`)}&doc=${encodeURIComponent(documentId)}`;
}
