"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MessageAttachment, MessageMention } from "@/shared/types/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSystemSpeaker, translateWorkspaceMessageSummary } from "@/features/i18n/presentation";
import { EmptyState } from "@/shared/ui/empty-state";
import { FeedbackBanner } from "@/shared/ui/feedback-banner";
import { GeneratedAvatar, type GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";
import { AppIcon } from "@/shared/ui/app-icon";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import type {
  ConversationListItem,
  ConversationMentionCandidate,
  ConversationThreadMessage,
} from "@/features/chat/conversation-shell";

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
  const isPendingMessage = message.status === "pending";
  const hasStreamedPendingContent = isPendingMessage && message.content.trim() !== "" && message.content.trim() !== "Thinking";
  const isError = message.status === "error";
  const isProcessMessage = message.kind === "process";
  const speakerLabel = translateSystemSpeaker(message.speaker, tx);
  const isFeishuMessage = message.data?.external_provider === "feishu";
  const replyToSpeakerLabel = replyToMessage ? translateSystemSpeaker(replyToMessage.speaker, tx) : "";
  const approvalAction = buildRuntimeApprovalAction(message, tx);
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

  if (isProcessMessage) {
    return (
      <div className="inbox-bubble-row" data-conversation-message-id={message.id}>
        <GeneratedAvatar
          className={`inbox-bubble-avatar${isError ? " inbox-bubble-avatar--error" : ""}`}
          id={`${message.role}:${message.speaker}`}
          name={speakerLabel}
          variant={message.role === "agent" ? "agent" : "human"}
        />
        <details className={`conversation-process${isError ? " conversation-process--error" : ""}`}>
          <summary>
            <span className="conversation-process__heading">
              {message.status === "pending" ? <AppIcon className="conversation-process__spinner" name="loader" /> : null}
              <strong>{processTitle(message, tx)}</strong>
            </span>
            <span className="conversation-process__state">
              {message.status === "pending" ? tx("进行中", "In progress") : renderMessageTimestamp(message.timestamp)}
            </span>
          </summary>
          <pre>{message.content}</pre>
        </details>
      </div>
    );
  }

  const hasActions = true;
  const acknowledgements = message.acknowledgements ?? [];
  const acknowledgementLabelForCurrentUser = acknowledgementActorLabel ?? ownSpeakerLabel;
  const acknowledgedByCurrentUser = acknowledgements.some((acknowledgement) =>
    acknowledgementLabelForCurrentUser
      ? acknowledgement.label.localeCompare(acknowledgementLabelForCurrentUser, "zh-CN", { sensitivity: "base" }) === 0
      : false,
  );
  const acknowledgementLabel = acknowledgements.map((acknowledgement) => acknowledgement.label).join("、");

  return (
    <div className={`inbox-bubble-row${own ? " inbox-bubble-row--own" : ""}`} data-conversation-message-id={message.id}>
      {!own ? (
        <GeneratedAvatar
          className={`inbox-bubble-avatar${isError ? " inbox-bubble-avatar--error" : ""}`}
          id={`${message.role}:${message.speaker}`}
          name={speakerLabel}
          variant={message.role === "agent" ? "agent" : "human"}
        />
      ) : null}
      <article
        className={`inbox-bubble${own ? " inbox-bubble--own" : ""}${isError ? " inbox-bubble--error" : ""}${
          isPendingMessage ? " inbox-bubble--pending" : ""
        }${message.pinned ? " inbox-bubble--pinned" : ""}`}
        tabIndex={hasActions && !isPendingMessage ? 0 : undefined}
      >
        {replyToMessage ? (
          <div className="inbox-bubble__reply-quote">
            <strong>{replyToSpeakerLabel}</strong>
            <span>{replyToMessage.content.slice(0, 80)}{replyToMessage.content.length > 80 ? "..." : ""}</span>
          </div>
        ) : null}
        <div className="inbox-bubble__meta">
          <strong>
            {own ? ownSpeakerLabel ?? tx("你", "You") : isError ? `${speakerLabel} · ${tx("错误", "Error")}` : speakerLabel}
            {isFeishuMessage ? (
              <span aria-label={tx("来自飞书", "From Feishu")} className="inbox-bubble__provider-icon" role="img">
                <AppIcon name="feishu" />
              </span>
            ) : null}
            {message.pinned ? <span className="inbox-bubble__pin-badge">{tx("已置顶", "Pinned")}</span> : null}
          </strong>
          <span>{isPendingMessage ? tx("思考中", "Thinking") : renderMessageTimestamp(message.timestamp)}</span>
        </div>
        {isPendingMessage ? (
          hasStreamedPendingContent ? (
            <p className="inbox-bubble__streaming-content">
              {renderMessageContent(translateWorkspaceMessageSummary(message, tx), message.mentions, tx)}
              <span aria-label={tx("正在生成", "Generating")} className="contacts-pending-dots contacts-pending-dots--inline">
                <span />
                <span />
                <span />
              </span>
            </p>
          ) : (
            <div className="contacts-pending-dots">
              <span />
              <span />
              <span />
            </div>
          )
        ) : (
          <p>{renderMessageContent(translateWorkspaceMessageSummary(message, tx), message.mentions, tx)}</p>
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
        {message.attachments?.length ? <ChatAttachmentRow attachments={message.attachments} /> : null}
        {acknowledgements.length > 0 ? (
          <div
            className="inbox-bubble__ack"
            title={tx(`${acknowledgementLabel} 已 OK`, `${acknowledgementLabel} acknowledged`)}
          >
            <span aria-hidden="true">👌</span>
            {acknowledgements.length > 1 ? <small>{acknowledgements.length}</small> : null}
          </div>
        ) : null}
        {hasActions && !isPendingMessage ? (
          <div className="inbox-bubble__actions">
            {onReply ? (
              <button aria-label={tx("回复", "Reply")} className="inbox-bubble__action-btn" onClick={onReply} title={tx("回复", "Reply")} type="button">
                <AppIcon name="reply" />
              </button>
            ) : null}
            <button
              aria-label={copied ? tx("已复制", "Copied") : tx("复制", "Copy")}
              className={`inbox-bubble__action-btn${copied ? " inbox-bubble__action-btn--active" : ""}`}
              onClick={() => {
                void copyMessageContent(message.content).then(() => {
                  setCopied(true);
                  if (copiedResetTimerRef.current !== null) {
                    window.clearTimeout(copiedResetTimerRef.current);
                  }
                  copiedResetTimerRef.current = window.setTimeout(() => {
                    setCopied(false);
                    copiedResetTimerRef.current = null;
                  }, 1600);
                }).catch(() => {});
              }}
              title={copied ? tx("已复制", "Copied") : tx("复制", "Copy")}
              type="button"
            >
              <AppIcon name="copy" />
            </button>
            {onPin ? (
              <button aria-label={tx("置顶", "Pin")} className="inbox-bubble__action-btn" onClick={onPin} title={tx("置顶", "Pin")} type="button">
                <AppIcon name="pin" />
              </button>
            ) : null}
            {onUnpin ? (
              <button aria-label={tx("取消置顶", "Unpin")} className="inbox-bubble__action-btn" onClick={onUnpin} title={tx("取消置顶", "Unpin")} type="button">
                <AppIcon name="pin" />
              </button>
            ) : null}
            {onAcknowledge ? (
              <button
                className={`inbox-bubble__action-btn${acknowledgedByCurrentUser ? " inbox-bubble__action-btn--active" : ""}`}
                onClick={onAcknowledge}
                title={tx("OK，标记已读", "OK, mark as read")}
                type="button"
              >
                <AppIcon name="checkCircle" />
              </button>
            ) : null}
          </div>
        ) : null}
      </article>
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

export function ChatAttachmentRow({ attachments }: { attachments: MessageAttachment[] }) {
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div className="chat-attachments">
      {images.length > 0 ? (
        <div className="chat-attachments__images">
          {images.map((attachment) => <AttachmentImageCard attachment={attachment} key={attachment.id} />)}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="chat-attachments__files">
          {files.map((attachment) => <AttachmentFileCard attachment={attachment} key={attachment.id} />)}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentImageCard({ attachment }: { attachment: MessageAttachment }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <AttachmentFileCard attachment={attachment} />;
  }

  return (
    <a
      className="chat-attachment-image"
      href={`/api/attachments/${attachment.id}`}
      rel="noreferrer"
      target="_blank"
    >
      {!loaded ? <span aria-hidden="true" className="chat-attachment-image__loading" /> : null}
      <img
        alt={attachment.fileName}
        className={`chat-attachment-image__img${loaded ? " chat-attachment-image__img--ready" : ""}`}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        src={`/api/attachments/${attachment.id}`}
      />
    </a>
  );
}

function AttachmentFileCard({ attachment }: { attachment: MessageAttachment }) {
  return (
    <a
      className="chat-attachment-file"
      href={`/api/attachments/${attachment.id}`}
      rel="noreferrer"
      target="_blank"
    >
      <span className="chat-attachment-file__icon">
        {fileIcon(attachment.mediaType, attachment.kind)}
      </span>
      <span className="chat-attachment-file__info">
        <strong>{attachment.fileName}</strong>
        <small>{formatFileSize(attachment.sizeBytes)}</small>
      </span>
    </a>
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
  draft,
  feedback,
  files,
  isPending,
  mentionSuggestions,
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
  onSelectMention,
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
}: {
  draft: string;
  feedback: string | null;
  files: Array<{ id: string; label: string }>;
  isPending: boolean;
  mentionSuggestions: ConversationMentionCandidate[];
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
  onPickedFiles: (files: FileList | null) => void;
  onRemoveFile: (id: string) => void;
  onSelectMention: (candidate: ConversationMentionCandidate) => void;
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
}) {
  const { tx } = useLanguage();
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueValue, setEditingQueueValue] = useState("");
  const hasDraft = draft.trim().length > 0 || files.length > 0;
  const isStopAction = isAgentRunning && !hasDraft;

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
      {feedback ? <FeedbackBanner feedback={{ tone: "error", message: feedback }} /> : null}
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
      {files.length > 0 ? (
        <div className="contacts-attachments">
          {files.map((item) => (
            <span className="contacts-attachment-chip" key={item.id}>
              <span>{item.label}</span>
              <button
                aria-label={tx(`移除 ${item.label}`, `Remove ${item.label}`)}
                className="contacts-attachment-remove"
                onClick={() => onRemoveFile(item.id)}
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
          onKeyDown={(event) => {
            const nativeEvent = event.nativeEvent as KeyboardEvent;
            if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
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

        {mentionSuggestions.length > 0 ? (
          <div className="contacts-mention-menu">
            {mentionSuggestions.map((candidate) => (
              <button
                className="contacts-mention-item"
                key={candidate.id}
                onClick={() => onSelectMention(candidate)}
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
                type="button"
              >
                <AppIcon name="plus" />
              </button>
              {showPicker ? (
                <div className="contacts-picker-menu" role="menu">
                  <button className="contacts-picker-item" onClick={() => mediaInputRef.current?.click()} type="button">
                    <span className="contacts-picker-item__icon">IMG</span>
                    <span>{tx("图片/视频", "Images / Videos")}</span>
                  </button>
                  <button className="contacts-picker-item" onClick={() => fileInputRef.current?.click()} type="button">
                    <span className="contacts-picker-item__icon">FILE</span>
                    <span>{tx("本地文件", "Local files")}</span>
                  </button>
                  <button className="contacts-picker-item" onClick={() => folderInputRef.current?.click()} type="button">
                    <span className="contacts-picker-item__icon">DIR</span>
                    <span>{tx("本地文件夹", "Local folder")}</span>
                  </button>
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">DOC</span>
                    <span>{tx("云文档", "Cloud doc")}</span>
                  </button>
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">CAL</span>
                    <span>{tx("日程", "Calendar")}</span>
                  </button>
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">CARD</span>
                    <span>{tx("个人名片", "Contact card")}</span>
                  </button>
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">TASK</span>
                    <span>{tx("任务", "Task")}</span>
                  </button>
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">A↔</span>
                    <span>{tx("开启边写边译", "Translate while typing")}</span>
                  </button>
                  <div className="contacts-picker-divider" />
                  <button className="contacts-picker-item contacts-picker-item--disabled" disabled type="button">
                    <span className="contacts-picker-item__icon">APP</span>
                    <span>{tx("快捷应用", "Quick apps")}</span>
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

export function ChatEmptyState({ title, body }: { title: string; body: string }) {
  return <EmptyState body={body} title={title} />;
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
  if (candidate.kind === "human") {
    return candidate.inChannel ? tx("群成员", "Member") : tx("其他成员", "Other member");
  }
  return candidate.inChannel ? tx("AI员工", "AI employee") : tx("其他 AI员工", "Other AI employee");
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
  return `/im?focus=${encodeURIComponent(`channel:${channelName}`)}&doc=${encodeURIComponent(documentId)}`;
}
