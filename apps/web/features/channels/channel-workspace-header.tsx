"use client";

// channels-page 工作区头部（3.4-3 拆分自 channels-page-client.tsx）。

import { useEffect } from "react";
import { ChatModelSelector } from "@/features/chat/chat-model-selector";
import type { ChannelsPageData } from "@/features/dashboard/data";
import { FeishuChannelSummaryPanel } from "@/features/integrations/feishu/feishu-channel-summary-panel";
import { HoverTooltip } from "@/shared/ui/hover-tooltip";
import { AppIcon } from "@/shared/ui/app-icon";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

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

  useEffect(() => {
    const openMenuRoot = showHeaderMenu
      ? headerMenuRef.current
      : showCreateMenu
        ? createMenuRef.current
        : null;
    if (!openMenuRoot) {
      return;
    }
    const menuRoot = openMenuRoot;
    const frame = window.requestAnimationFrame(() => {
      menuRoot.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      if (showHeaderMenu) {
        onShowHeaderMenu();
      } else {
        onOpenCreateMenu();
      }
      menuRoot.querySelector<HTMLButtonElement>("[aria-haspopup='menu']")?.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [createMenuRef, headerMenuRef, onOpenCreateMenu, onShowHeaderMenu, showCreateMenu, showHeaderMenu]);

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
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
                  expanded={showHeaderMenu}
                  hasPopup
                  label={tx("更多", "More")}
                  onClick={onShowHeaderMenu}
                >
                  <MoreIcon />
                </HeaderIconButton>
                {showHeaderMenu ? (
                  <div
                    aria-label={tx("更多操作", "More actions")}
                    className="channel-workspace-header__menu"
                    onKeyDown={handleMenuKeyDown}
                    role="menu"
                  >
                    <button className="channel-workspace-header__menu-item" onClick={onCreateAnnouncement} role="menuitem" type="button">
                      <AddCardIcon />
                      <span>{tx("添加群公告", "Add announcement")}</span>
                    </button>
                    <button className="channel-workspace-header__menu-item" onClick={onCreateLabelPage} role="menuitem" type="button">
                      <AddCardIcon />
                      <span>{tx("添加标签页", "Add tab page")}</span>
                    </button>
                    <button className="channel-workspace-header__menu-item" onClick={onOpenTaskBoard} role="menuitem" type="button">
                      <EditIcon />
                      <span>{tx("查看任务", "View tasks")}</span>
                    </button>
                    {canRenameChannel ? (
                      <button className="channel-workspace-header__menu-item" onClick={onOpenRename} role="menuitem" type="button">
                        <EditIcon />
                        <span>{tx("修改群名", "Rename group")}</span>
                      </button>
                    ) : null}
                    {canManageChannel ? (
                      <button
                        className="channel-workspace-header__menu-item channel-workspace-header__menu-item--danger"
                        disabled={pending}
                        onClick={onDeleteChannel}
                        role="menuitem"
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
            aria-expanded={showCreateMenu}
            aria-haspopup="menu"
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
            <div
              aria-label={tx("新建内容", "Create content")}
              className="channel-workspace-header__menu channel-workspace-header__menu--compact"
              onKeyDown={handleMenuKeyDown}
              role="menu"
            >
              <button className="channel-workspace-header__menu-item" onClick={onUploadFiles} role="menuitem" type="button">
                <FolderIcon />
                <span>{tx("上传文件", "Upload files")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateDocument} role="menuitem" type="button">
                <CloudDocIcon />
                <span>{tx("新建云文档", "New cloud doc")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateNativeSheet} role="menuitem" type="button">
                <SheetIcon />
                <span>{tx("新建表格", "New sheet")}</span>
              </button>
              <button className="channel-workspace-header__menu-item" onClick={onCreateNativeDeck} role="menuitem" type="button">
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
