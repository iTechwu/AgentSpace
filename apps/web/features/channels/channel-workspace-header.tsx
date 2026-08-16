"use client";

// channels-page 工作区头部（3.4-3 拆分自 channels-page-client.tsx）。

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
  AddCardIcon,
  CalendarIcon,
  CloudDocIcon,
  EditIcon,
  FolderIcon,
  MessageBubbleIcon,
  MoreIcon,
  SearchIcon,
  SheetIcon,
  TrashIcon,
  UserPlusIcon,
  VideoIcon,
} from "@/features/channels/channels-page-icons";
import {
  ChannelTabButton,
  HeaderIconButton,
} from "@/features/channels/channels-page-views";
import type {
  ChannelWorkspaceTab,
  FeishuChannelMemberSnapshot,
} from "@/features/channels/channels-page-shared";

export function ChannelWorkspaceHeader({
  activeTab,
  backButton,
  contentTabsEnabled,
  createMenuRef,
  headerMenuRef,
  liveFeishuMembers,
  memberCount,
  onCreateAnnouncement,
  onCreateDocument,
  onCreateNativeDeck,
  onCreateNativeSheet,
  onCreateLabelPage,
  onDeleteChannel,
  onOpenAddMembers,
  onOpenCalendar,
  onOpenCreateMenu,
  onOpenContactRemark,
  onOpenRename,
  onOpenTaskBoard,
  onSearchAction,
  onShowHeaderMenu,
  onSwitchTab,
  onUploadFiles,
  pending,
  selectedChannel,
  showCreateMenu,
  showHeaderMenu,
  tx,
}: {
  activeTab: ChannelWorkspaceTab;
  backButton: React.ReactNode | null;
  contentTabsEnabled: boolean;
  createMenuRef: React.RefObject<HTMLDivElement | null>;
  headerMenuRef: React.RefObject<HTMLDivElement | null>;
  liveFeishuMembers?: FeishuChannelMemberSnapshot;
  memberCount: number;
  onCreateAnnouncement: () => void;
  onCreateDocument: () => void;
  onCreateNativeDeck: () => void;
  onCreateNativeSheet: () => void;
  onCreateLabelPage: () => void;
  onDeleteChannel: () => void;
  onOpenAddMembers: () => void;
  onOpenCalendar: () => void;
  onOpenCreateMenu: () => void;
  onOpenContactRemark: () => void;
  onOpenRename: () => void;
  onOpenTaskBoard: () => void;
  onSearchAction: () => void;
  onShowHeaderMenu: () => void;
  onSwitchTab: (tab: ChannelWorkspaceTab) => void;
  onUploadFiles: () => void;
  pending: boolean;
  selectedChannel: ChannelsPageData["channels"][number];
  showCreateMenu: boolean;
  showHeaderMenu: boolean;
  tx: (zh: string, en: string) => string;
}) {
  const isDirect = selectedChannel.kind === "direct";
  const canManageChannel = selectedChannel.canManage !== false;
  const canRenameChannel = canRenameChannelFromHeader(selectedChannel);

  return (
    <header className="channel-workspace-header">
      <div className="channel-workspace-header__top">
        <div className="channel-workspace-header__main">
          {backButton ? <div className="channel-workspace-header__back">{backButton}</div> : null}
          <GeneratedAvatar
            className="channel-workspace-header__avatar"
            id={selectedChannel.contactId ?? selectedChannel.channelName ?? selectedChannel.id}
            name={selectedChannel.displayName ?? selectedChannel.name}
            variant={isDirect ? "agent" : "channel"}
          />
          <div className="channel-workspace-header__copy">
            <div className="channel-workspace-header__title-row">
              <h2>
                {isDirect && selectedChannel.contactId ? (
                  <ChatModelSelector
                    canManage={selectedChannel.canManage !== false}
                    contactId={selectedChannel.contactId}
                    displayName={selectedChannel.displayName ?? selectedChannel.name}
                  />
                ) : (
                  selectedChannel.displayName ?? selectedChannel.name
                )}
              </h2>
              {canRenameChannel ? (
                <HoverTooltip align="center" content={tx("修改群名", "Rename group")}>
                  {({ describedBy }) => (
                    <button
                      aria-describedby={describedBy}
                      aria-label={tx("修改群名", "Rename group")}
                      className="channel-workspace-header__title-edit-button"
                      onClick={onOpenRename}
                      title={tx("修改群名", "Rename group")}
                      type="button"
                    >
                      <EditIcon />
                    </button>
                  )}
                </HoverTooltip>
              ) : null}
              {liveFeishuMembers ? (
                <>
                  <span
                    aria-label={tx(`${liveFeishuMembers.userCount} 位成员`, `${liveFeishuMembers.userCount} members`)}
                    className="channel-workspace-header__members"
                  >
                    <AppIcon name="groups" />
                    {liveFeishuMembers.userCount}
                  </span>
                  <span
                    aria-label={tx(`${liveFeishuMembers.botCount} 个机器人`, `${liveFeishuMembers.botCount} bots`)}
                    className="channel-workspace-header__members"
                  >
                    <AppIcon name="agents" />
                    {liveFeishuMembers.botCount}
                  </span>
                </>
              ) : (
                <span className="channel-workspace-header__members">
                  <AppIcon name="groups" />
                  {memberCount}
                </span>
              )}
              <span className="channel-workspace-header__badge">{isDirect ? tx("私聊", "Direct") : tx("全员", "All")}</span>
            </div>
            {selectedChannel.displaySubtitle ? (
              <p className="channel-workspace-header__subtitle">{selectedChannel.displaySubtitle}</p>
            ) : null}
          </div>
        </div>

        <div className="channel-workspace-header__actions">
          {isDirect ? (
            <HeaderIconButton label={tx("编辑备注", "Edit remark")} onClick={onOpenContactRemark}>
              <EditIcon />
            </HeaderIconButton>
          ) : null}
          <HeaderIconButton label={tx("搜索", "Search")} onClick={onSearchAction}>
            <SearchIcon />
          </HeaderIconButton>
          <HeaderIconButton label={tx("视频会议（暂不可用）", "Video meeting (not available yet)")}>
            <VideoIcon />
          </HeaderIconButton>
          {!isDirect ? (
            <>
              {canManageChannel ? (
                <HoverTooltip align="center" content={tx("添加群成员", "Add members")}>
                  {({ describedBy }) => (
                    <HeaderIconButton describedBy={describedBy} label={tx("添加群成员", "Add members")} onClick={onOpenAddMembers}>
                      <UserPlusIcon />
                    </HeaderIconButton>
                  )}
                </HoverTooltip>
              ) : null}
              <HeaderIconButton label={tx("日历", "Calendar")} onClick={onOpenCalendar}>
                <CalendarIcon />
              </HeaderIconButton>
              <div className="channel-workspace-header__menu-wrap" ref={headerMenuRef}>
                <HeaderIconButton
                  active={showHeaderMenu}
                  label={tx("更多", "More")}
                  onClick={onShowHeaderMenu}
                >
                  <MoreIcon />
                </HeaderIconButton>
                {showHeaderMenu ? (
                  <div className="channel-workspace-header__menu">
                    <button className="channel-workspace-header__menu-item" onClick={onCreateAnnouncement} type="button">
                      <AddCardIcon />
                      <span>{tx("添加群公告", "Add announcement")}</span>
                    </button>
                    <button className="channel-workspace-header__menu-item" onClick={onCreateLabelPage} type="button">
                      <AddCardIcon />
                      <span>{tx("添加标签页", "Add tab page")}</span>
                    </button>
                    <button className="channel-workspace-header__menu-item" onClick={onOpenTaskBoard} type="button">
                      <EditIcon />
                      <span>{tx("查看任务", "View tasks")}</span>
                    </button>
                    {canRenameChannel ? (
                      <button className="channel-workspace-header__menu-item" onClick={onOpenRename} type="button">
                        <EditIcon />
                        <span>{tx("修改群名", "Rename group")}</span>
                      </button>
                    ) : null}
                    {canManageChannel ? (
                      <button
                        className="channel-workspace-header__menu-item channel-workspace-header__menu-item--danger"
                        disabled={pending}
                        onClick={onDeleteChannel}
                        type="button"
                      >
                        <TrashIcon />
                        <span>{tx("删除群组", "Delete group")}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {selectedChannel.feishu ? (
        <FeishuChannelSummaryPanel feishu={selectedChannel.feishu} tx={tx} />
      ) : null}

      <div className="channel-workspace-header__tabs">
        <ChannelTabButton
          active={activeTab === "messages"}
          icon={<MessageBubbleIcon />}
          label={tx("消息", "Messages")}
          onClick={() => onSwitchTab("messages")}
        />
        <ChannelTabButton
          active={activeTab === "files"}
          disabled={!contentTabsEnabled}
          disabledReason={tx("发送首条消息后可使用文件", "Files become available after the first message")}
          icon={<FolderIcon />}
          label={tx("文件", "Files")}
          onClick={() => onSwitchTab("files")}
        />
        <ChannelTabButton
          active={activeTab === "documents"}
          disabled={!contentTabsEnabled}
          disabledReason={tx("发送首条消息后可使用云文档", "Cloud docs become available after the first message")}
          icon={<CloudDocIcon />}
          label={tx("云文档", "Docs")}
          onClick={() => onSwitchTab("documents")}
        />
        <div className="channel-workspace-header__menu-wrap" ref={createMenuRef}>
          <button
            aria-label={tx("新建内容", "Create content")}
            className="channel-workspace-header__tab-plus"
            disabled={!contentTabsEnabled}
            onClick={onOpenCreateMenu}
            title={contentTabsEnabled ? tx("新建内容", "Create content") : tx("发送首条消息后可新建内容", "Create content after the first message")}
            type="button"
          >
            <AppIcon name="plus" />
          </button>
          {showCreateMenu ? (
            <div className="channel-workspace-header__menu channel-workspace-header__menu--compact">
              <button className="channel-workspace-header__menu-item" onClick={onUploadFiles} type="button">
                <FolderIcon />
                <span>{tx("上传文件", "Upload files")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateDocument} type="button">
                <CloudDocIcon />
                <span>{tx("新建云文档", "New cloud doc")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateNativeSheet} type="button">
                <SheetIcon />
                <span>{tx("新建表格", "New sheet")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateNativeDeck} type="button">
                <CloudDocIcon />
                <span>{tx("新建 Deck", "New deck")}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function canRenameChannelFromHeader(channel: ChannelsPageData["channels"][number]): boolean {
  return channel.kind !== "direct" && (channel.accessState === undefined || channel.accessState === "accessible");
}
