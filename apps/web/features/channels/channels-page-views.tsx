"use client";

// channels-page 展示视图：目录面板 / 访问门 / 加载与错误态 / Tab 按钮 / 文件 / 文档概览 / 搜索框（3.4-3 拆分）。

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  addWorkspaceMembersToChannelAction,
  addChannelDocumentCollaboratorAction,
  archiveChannelDocumentAction,
  createChannelAction,
  createChannelDocumentFromAttachmentAction,
  getChannelDetailDataAction,
  getFeishuChannelMemberSnapshotAction,
  deleteChannelAttachmentAction,
  deleteChannelAction,
  exportChannelDocumentAttachmentAction,
  pinMessageAction,
  requestChannelAccessAction,
  unpinMessageAction,
  removeChannelDocumentCollaboratorAction,
  renameChannelAction,
  reviewInlineApprovalAction,
  resolveChannelDocumentConflictAction,
  restoreChannelDocumentAction,
  retryChannelDocumentConflictAction,
  touchChannelDocumentPresenceAction,
  updateDigitalContactRemarkAction,
  updateChannelDocumentAccessRoleAction,
  rollbackChannelDocumentVersionAction,
  saveChannelDocumentAction,
  sendContactMessageAction,
  sendChannelMessageAction,
  stopChannelTaskAction,
  acknowledgeMessageAction,
} from "@/features/channels/actions";
import { CreateChannelModal } from "@/features/channels/create-channel-modal";
import {
  ConversationShell,
  type ConversationComposerRuntime,
  type ConversationListItem,
  type ConversationMentionCandidate,
  type ConversationThreadMessage,
} from "@/features/chat/conversation-shell";
import { updateWorkspaceAgentExecutionPolicyAction } from "@/features/agents/actions";
import { buildExecutionTimeline } from "@/features/chat/task-execution-timeline";
import { CommunicationListActions } from "@/features/chat/communication-list-actions";
import { ChatModelCommandDialog, ChatModelSelector } from "@/features/chat/chat-model-selector";
import type { ChannelsPageData } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { useWorkspaceModuleNavigation } from "@/features/dashboard/workspace-module-navigation";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import {
  scopeWorkspaceModuleCacheKey,
  useOptionalWorkspaceModuleCache,
  useWorkspaceModuleCacheRevision,
  useWorkspaceModuleCacheScope,
} from "@/features/dashboard/workspace-module-cache";
import { ChannelDocumentsPanel } from "@/features/channels/channel-documents-panel";
import { OpenMontageChannelJobs } from "@/features/channels/openmontage-channel-jobs";
import { buildWorkspacePath, parseWorkspacePathname } from "@/features/auth/workspace-paths";
import { FeishuChannelSummaryPanel } from "@/features/integrations/feishu/feishu-channel-summary-panel";
import { useLanguage } from "@/features/i18n/language-provider";
import { HoverTooltip } from "@/shared/ui/hover-tooltip";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { isDocumentInputActive } from "@/shared/lib/use-auto-refresh";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";
import {
  translateMemberLabel,
  translateSystemSpeaker,
  translateWorkspaceMessageSummary,
} from "@/features/i18n/presentation";

import {
  formatChannelFileSize,
  formatChannelWorkspaceTime,
} from "@/features/channels/channels-page-model";
import {
  CloudDocIcon,
  SearchIcon,
  SheetIcon,
  UserPlusIcon,
} from "@/features/channels/channels-page-icons";
import type {
  ChannelRecord,
  ChannelWorkspaceTab,
} from "@/features/channels/channels-page-shared";

export function DigitalEmployeeDirectoryHeader({
  backButton,
  channel,
  onManage,
  onMessage,
  tx,
}: {
  backButton: React.ReactNode | null;
  channel: ChannelRecord;
  onManage: () => void;
  onMessage: () => void;
  tx: (zh: string, en: string) => string;
}) {
  const displayName = channel.displayName ?? channel.name;
  const identity = channel.contactId ?? channel.displaySubtitle ?? channel.name;
  return (
    <header className="contacts-chat-header digital-employee-directory-header">
      <div className="contacts-chat-header__main">
        {backButton ? <div className="contacts-chat-header__leading">{backButton}</div> : null}
        <GeneratedAvatar
          className="contacts-chat-header__avatar"
          id={identity}
          name={displayName}
          variant="agent"
        />
        <div>
          <h3>{displayName}</h3>
          <p>{identity}</p>
        </div>
      </div>
      <div className="digital-employee-directory-header__actions">
        <button className="action-button" onClick={onManage} type="button">
          <AppIcon name="agents" />
          {tx("管理", "Manage")}
        </button>
        <button className="primary-button" onClick={onMessage} type="button">
          <AppIcon name="messages" />
          {tx("发消息", "Message")}
        </button>
      </div>
    </header>
  );
}

export function DigitalEmployeeDirectoryDetail({
  channel,
  hasConversation,
  lastMessage,
  tx,
}: {
  channel: ChannelRecord;
  hasConversation: boolean;
  lastMessage?: string;
  tx: (zh: string, en: string) => string;
}) {
  const displayName = channel.displayName ?? channel.name;
  const identity = channel.contactId ?? channel.displaySubtitle ?? channel.name;
  return (
    <section className="digital-employee-directory-detail">
      <div className="digital-employee-directory-detail__intro">
        <p className="page-eyebrow">{tx("数字员工资料", "Digital employee profile")}</p>
        <h2>{displayName}</h2>
        <p>{tx("在联系人中查看身份与会话状态；消息内容统一在消息模块中处理。", "Review identity and conversation status here; continue the conversation in Messages.")}</p>
      </div>
      <dl className="digital-employee-directory-detail__facts">
        <div>
          <dt>{tx("类型", "Type")}</dt>
          <dd>{tx("数字员工", "Digital employee")}</dd>
        </div>
        <div>
          <dt>{tx("AI员工 标识", "AI employee identity")}</dt>
          <dd>{identity}</dd>
        </div>
        <div>
          <dt>{tx("私聊状态", "Direct message status")}</dt>
          <dd>{hasConversation ? tx("已建立", "Available") : tx("尚未开始", "Not started")}</dd>
        </div>
        <div>
          <dt>{tx("最近消息", "Latest message")}</dt>
          <dd>{lastMessage ?? tx("暂无消息", "No messages")}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ChannelAccessGate({
  accessState,
  channelName,
  feedback,
  onRequestAccess,
  pending,
  tx,
}: {
  accessState: "accessible" | "pending" | "requestable";
  channelName: string;
  feedback: string | null;
  onRequestAccess: () => void;
  pending: boolean;
  tx: (zh: string, en: string) => string;
}) {
  const isPendingAccess = accessState === "pending";
  return (
    <div className="channel-access-gate">
      <section className="channel-access-gate__card" aria-label={tx("申请加入群", "Request channel access")}>
        <div className="channel-access-gate__icon">
          <UserPlusIcon />
        </div>
        <div className="channel-access-gate__content">
          <span className="channel-access-gate__eyebrow">{tx("群组访问", "Group access")}</span>
          <h3>
            {isPendingAccess
              ? tx(`已提交加入「${channelName}」申请`, `Request sent for "${channelName}"`)
              : tx(`申请加入「${channelName}」`, `Request to join "${channelName}"`)}
          </h3>
          <p>
            {isPendingAccess
              ? tx("管理员批准后，会自动解锁这个群的消息、文件和文档。", "Messages, files, and documents unlock automatically after an admin approves.")
              : tx("你已经在这个工作区里，可以先看到群名称。提交申请后，管理员批准即可进入群协作。", "You are already in this workspace, so the group is visible. Request access and an admin can approve you into the collaboration flow.")}
          </p>
          <div className="channel-access-gate__steps" aria-hidden="true">
            <span className="channel-access-gate__step channel-access-gate__step--done">{tx("提交申请", "Request")}</span>
            <span className={`channel-access-gate__step${isPendingAccess ? " channel-access-gate__step--active" : ""}`}>
              {tx("管理员审批", "Admin review")}
            </span>
            <span className="channel-access-gate__step">{tx("解锁内容", "Unlock")}</span>
          </div>
          {feedback ? <p aria-live="polite" className="channel-access-gate__feedback" role="status">{feedback}</p> : null}
        </div>
        <div className="channel-access-gate__actions">
          {isPendingAccess ? (
            <span className="status-chip status-chip--active">{tx("等待审批", "Pending approval")}</span>
          ) : (
            <button className="primary-button channel-access-gate__button" disabled={pending} onClick={onRequestAccess} type="button">
              {pending ? tx("提交中...", "Submitting...") : tx("申请加入群", "Request access")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

export function ChannelDetailLoadingState({
  tab,
  tx,
}: {
  tab: ChannelWorkspaceTab;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className={`channel-detail-state channel-detail-state--${tab}`} role="status">
      <div className="channel-detail-state__line channel-detail-state__line--wide" />
      <div className="channel-detail-state__line" />
      <div className="channel-detail-state__line channel-detail-state__line--short" />
      <span className="sr-only">{tx("正在加载会话内容", "Loading conversation details")}</span>
    </div>
  );
}

export function ChannelDetailErrorState({
  message,
  onRetry,
  tx,
}: {
  message: string;
  onRetry: () => void;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className="channel-detail-state channel-detail-state--error">
      <EmptyState
        actionLabel={tx("重试", "Retry")}
        body={message}
        onAction={onRetry}
        title={tx("会话内容加载失败", "Could not load conversation")}
        variant="warm"
      />
    </div>
  );
}

export function ChannelTabButton({
  active,
  disabled = false,
  disabledReason,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`channel-workspace-tab${active ? " channel-workspace-tab--active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledReason : undefined}
      type="button"
    >
      <span className="channel-workspace-tab__icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function HeaderIconButton({
  active = false,
  children,
  describedBy,
  label,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  describedBy?: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-describedby={describedBy}
      aria-label={label}
      className={`channel-workspace-header__icon-button${active ? " channel-workspace-header__icon-button--active" : ""}`}
      disabled={!onClick}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

export function ChannelFilesView({
  files,
  feedback,
  onCreateDocument,
  onDeleteFile,
  onFileSearchChange,
  searchInputRef,
  onUpload,
  pending,
  searchValue,
  tx,
}: {
  files: ChannelsPageData["channelFiles"];
  feedback: string | null;
  onCreateDocument: (attachmentId: string, fileName: string) => void;
  onDeleteFile: (file: ChannelsPageData["channelFiles"][number]) => void;
  onFileSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: () => void;
  pending: boolean;
  searchValue: string;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <section className="channel-workspace-panel">
      <div className="channel-workspace-panel__toolbar">
        <SearchField
          inputRef={searchInputRef}
          onChange={onFileSearchChange}
          placeholder={tx("搜索会话内的文件", "Search files in this channel")}
          value={searchValue}
        />
        <button className="action-button" disabled={pending} onClick={onUpload} type="button">
          {tx("上传文件", "Upload")}
        </button>
      </div>
      {feedback ? <p aria-live="polite" className="settings-feedback" role="status">{feedback}</p> : null}

      <div className="channel-workspace-list">
        <div className="channel-workspace-list__head">
          <span>{tx("标题", "Title")}</span>
          <span>{tx("发送人", "Sender")}</span>
          <span>{tx("发送时间", "Sent at")}</span>
          <span>{tx("操作", "Actions")}</span>
        </div>
        {files.length > 0 ? (
          files.map((file) => (
            <div className="channel-workspace-row" key={file.id}>
              <div className="channel-workspace-row__title">
                <span className={`channel-workspace-row__icon channel-workspace-row__icon--${file.kind}`}>
                  {file.kind === "image" ? "IMG" : file.mediaType.includes("pdf") ? "PDF" : "FILE"}
                </span>
                <div>
                  <strong>{file.fileName}</strong>
                  <small>{formatChannelFileSize(file.sizeBytes)}</small>
                </div>
              </div>
              <span>{translateSystemSpeaker(file.sourceSpeaker, tx) || tx("未知", "Unknown")}</span>
              <span>{formatChannelWorkspaceTime(file.sourceTime)}</span>
              <div className="channel-workspace-row__actions">
                <a className="action-button" href={`/api/attachments/${file.id}`} rel="noreferrer" target="_blank">
                  {tx("打开", "Open")}
                </a>
                {file.isMarkdown ? (
                  <button className="action-button" disabled={pending} onClick={() => onCreateDocument(file.id, file.fileName)} type="button">
                    {tx("转为云文档", "Import")}
                  </button>
                ) : null}
                {file.canDelete ? (
                  <button
                    className="action-button action-button--danger"
                    disabled={pending}
                    onClick={() => onDeleteFile(file)}
                    type="button"
                  >
                    {tx("删除", "Delete")}
                  </button>
                ) : file.deleteBlockedReason ? (
                  <button className="action-button" disabled title={file.deleteBlockedReason} type="button">
                    {tx("删除", "Delete")}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            body={tx("发送附件后，文件会出现在这里。", "Files sent to this channel will appear here.")}
            title={tx("还没有群文件", "No shared files yet")}
          />
        )}
      </div>
    </section>
  );
}

export function ChannelDocumentsOverview({
  archivedDocuments,
  documents,
  onCreateDocument,
  onDeleteDocument,
  onDocumentSearchChange,
  searchInputRef,
  onOpenDocument,
  pending,
  searchValue,
  tx,
}: {
  archivedDocuments: ChannelsPageData["documents"];
  documents: ChannelsPageData["documents"];
  onCreateDocument: () => void;
  onDeleteDocument: (document: ChannelsPageData["documents"][number]) => void;
  onDocumentSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenDocument: (documentId: string) => void;
  pending: boolean;
  searchValue: string;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <section className="channel-workspace-panel">
      <div className="channel-workspace-panel__toolbar">
        <SearchField
          inputRef={searchInputRef}
          onChange={onDocumentSearchChange}
          placeholder={tx("搜索会话内的云文档", "Search docs in this channel")}
          value={searchValue}
        />
        <button className="action-button" disabled={pending} onClick={onCreateDocument} type="button">
          {tx("新建云文档", "New doc")}
        </button>
      </div>

      <div className="channel-workspace-list">
        <div className="channel-workspace-list__head">
          <span>{tx("标题", "Title")}</span>
          <span>{tx("发送人", "Author")}</span>
          <span>{tx("发送时间", "Updated")}</span>
          <span>{tx("操作", "Actions")}</span>
        </div>
        {documents.length > 0 ? (
          documents.map((document) => (
            <div className="channel-workspace-row" key={document.id}>
              <div className="channel-workspace-row__title">
                <span className="channel-workspace-row__icon channel-workspace-row__icon--doc">
                  {document.kind === "sheet" ? <SheetIcon /> : <CloudDocIcon />}
                </span>
                <div>
                  <strong>{document.title}</strong>
                  <small>{document.summary || tx("暂无摘要", "No summary yet")}</small>
                </div>
              </div>
              <span>{translateSystemSpeaker(document.updatedBy, tx)}</span>
              <span>{formatChannelWorkspaceTime(document.updatedAt)}</span>
              <div className="channel-workspace-row__actions">
                <button className="action-button" onClick={() => onOpenDocument(document.id)} type="button">
                  {tx("打开", "Open")}
                </button>
                <button
                  className="action-button action-button--danger"
                  disabled={pending || document.currentUserRole !== "owner"}
                  onClick={() => onDeleteDocument(document)}
                  title={document.currentUserRole === "owner" ? undefined : tx("只有所有者可以删除", "Only owners can delete")}
                  type="button"
                >
                  {tx("删除", "Delete")}
                </button>
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            body={tx("先创建一份群组云文档，用来沉淀长期协作内容。", "Create a cloud doc first for long-term collaboration.")}
            title={tx("还没有云文档", "No cloud docs yet")}
          />
        )}
      </div>

      {archivedDocuments.length > 0 ? (
        <div className="channel-workspace-archived">
          <div className="channel-workspace-archived__header">
            <strong>{tx("已删除文档", "Deleted docs")}</strong>
            <span>{archivedDocuments.length}</span>
          </div>
          <div className="channel-workspace-archived__list">
            {archivedDocuments.map((document) => (
              <div className="channel-workspace-archived__item" key={document.id}>
                <strong>{document.title}</strong>
                <small>
                  {translateSystemSpeaker(document.updatedBy, tx)} · {formatChannelWorkspaceTime(document.updatedAt)}
                </small>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SearchField({
  inputRef,
  onChange,
  placeholder,
  value,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="channel-workspace-search">
      <span className="channel-workspace-search__icon">
        <SearchIcon />
      </span>
      <input
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        ref={inputRef}
        type="search"
        value={value}
      />
    </label>
  );
}
