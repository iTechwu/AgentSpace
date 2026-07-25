"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { inviteExternalContactToChannelAction, sendHumanDirectMessageAction } from "@/features/channels/actions";
import { ConversationShell, type ConversationListItem, type ConversationThreadMessage } from "@/features/chat/conversation-shell";
import { CommunicationListActions } from "@/features/chat/communication-list-actions";
import type { HumanContactItem, HumanContactThread } from "@/features/contacts/human-contacts-data";
import { buildWorkspacePath, parseWorkspacePathname } from "@/features/auth/workspace-paths";
import { useWorkspaceModuleNavigation } from "@/features/dashboard/workspace-module-navigation";
import { useLanguage } from "@/features/i18n/language-provider";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

export function HumanContactsPageClient({
  channels,
  contacts,
  currentUserDisplayName,
  threads,
}: {
  channels: string[];
  contacts: HumanContactItem[];
  currentUserDisplayName: string;
  threads: HumanContactThread[];
}) {
  const { tx } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const { navigateWorkspaceModule } = useWorkspaceModuleNavigation();
  const { workspaceSlug } = parseWorkspacePathname(pathname);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(contacts[0]?.id ?? null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [externalEmail, setExternalEmail] = useState("");
  const [targetChannel, setTargetChannel] = useState(channels[0] ?? "");
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const [latestInvitePath, setLatestInvitePath] = useState<string | null>(null);
  const [showContactProfile, setShowContactProfile] = useState(false);

  useEffect(() => {
    if (!selectedContactId || !contacts.some((contact) => contact.id === selectedContactId)) {
      setSelectedContactId(contacts[0]?.id ?? null);
    }
  }, [contacts, selectedContactId]);

  useEffect(() => {
    if (!targetChannel || !channels.includes(targetChannel)) {
      setTargetChannel(channels[0] ?? "");
    }
  }, [channels, targetChannel]);

  useEffect(() => {
    setShowContactProfile(false);
  }, [selectedContactId]);

  const selectedContact = contacts.find((contact) => contact.id === selectedContactId) ?? null;
  const selectedThread = selectedContact
    ? threads.find((thread) => thread.contactId === selectedContact.id) ?? null
    : null;
  const items: ConversationListItem[] = contacts.map((contact) => ({
    id: contact.id,
    title: contact.name,
    subtitle: contact.subtitle,
    meta: contact.lastMessage ?? tx("还没有私聊消息", "No direct messages yet"),
    avatar: contact.name.slice(0, 1).toUpperCase(),
    avatarId: contact.id,
    avatarName: contact.name,
    avatarVariant: "human",
    dateLabel: formatCompactTimestamp(contact.updatedAt, { emptyFallback: "" }),
  }));
  const messages: ConversationThreadMessage[] = selectedThread?.messages.map((message, index) => ({
    id: message.id || `${message.speaker}-${message.time}-${index}`,
    speaker: message.speaker,
    role: message.role,
    content: message.summary,
    code: message.code,
    data: message.data,
    timestamp: formatCompactTimestamp(message.time, { emptyFallback: message.time }),
    status: message.status ?? "completed",
    attachments: message.attachments,
    mentions: message.mentions,
    acknowledgements: message.acknowledgements,
    kind: message.kind,
    processType: message.processType,
    tool: message.tool,
    pinned: message.pinned,
    pinnedAt: message.pinnedAt,
    replyToMessageId: message.replyToMessageId,
  })) ?? [];

  return (
    <>
    <ConversationShell
      emptyListBody={tx("邀请同事加入工作区后，真人联系人会显示在这里。", "Human contacts appear here after teammates join the workspace.")}
      emptyListTitle={tx("暂无真人联系人", "No human contacts")}
      emptyThreadBody={
        selectedContact
          ? tx("发一条消息开始同工作区真人私聊。", "Send a message to start a workspace direct chat.")
          : tx("从左侧选择一位成员开始私聊。", "Select a person from the list to start a direct chat.")
      }
      emptyThreadTitle={selectedContact ? tx("还没有消息", "No messages yet") : tx("未选择联系人", "No contact selected")}
      headerActions={null}
      items={items}
      listActions={
        <CommunicationListActions
          action={{
            label: tx("添加真人联系人", "Add person"),
            onClick: () => setShowAddContact(true),
          }}
          activeTab="people"
          ariaLabel={tx("联系人类型", "Contact type")}
          tabs={[
            {
              id: "people",
              label: tx("真人", "People"),
              onSelect: () => {},
            },
            {
              id: "digital",
              label: tx("数字员工", "Digital employees"),
              onSelect: () => {
                const href = workspaceSlug
                  ? buildWorkspacePath(workspaceSlug, "/im?view=direct&context=contacts")
                  : "/im?view=direct&context=contacts";
                if (!navigateWorkspaceModule(href)) {
                  router.push(href);
                }
              },
            },
          ]}
        />
      }
      listCount={contacts.length}
      listKicker=""
      listTitle={tx("联系人", "Contacts")}
      messages={messages}
      customThreadHeader={({ backButton }) =>
        selectedContact ? (
          <HumanContactChatHeader
            backButton={backButton}
            contact={selectedContact}
            open={showContactProfile}
            tx={tx}
            onToggleProfile={() => setShowContactProfile((current) => !current)}
            onCloseProfile={() => setShowContactProfile(false)}
          />
        ) : null
      }
      onSelectItem={setSelectedContactId}
      currentUserDisplayName={currentUserDisplayName}
      onSubmit={async ({ content, files, replyToMessageId }) => {
        if (!selectedContact) {
          return;
        }
        const formData = new FormData();
        formData.set("targetUserId", selectedContact.id);
        formData.set("content", content);
        if (replyToMessageId) {
          formData.set("replyToMessageId", replyToMessageId);
        }
        files.forEach((file) => formData.append("attachments", file));
        await sendHumanDirectMessageAction(formData);
      }}
      placeholder={
        selectedContact
          ? tx(`发送给 ${selectedContact.name}`, `Send to ${selectedContact.name}`)
          : tx("发送消息", "Send a message")
      }
      shellClassName="contacts-shell--chatting contacts-shell--human"
      selectedHeader={
        selectedContact
          ? {
              title: selectedContact.name,
              subtitle: selectedContact.subtitle,
              avatar: selectedContact.name.slice(0, 1).toUpperCase(),
              avatarId: selectedContact.id,
              avatarName: selectedContact.name,
              avatarVariant: "human",
            }
          : null
      }
      selectedItemId={selectedContactId}
    />
    {showAddContact ? (
      <div className="modal-backdrop" role="presentation">
        <div aria-label={tx("添加真人联系人", "Add human contact")} aria-modal="true" className="modal-card modal-card--compact" role="dialog">
          <div className="modal-card__header">
            <div>
              <h3>{tx("添加真人联系人", "Add human contact")}</h3>
              <p>{tx("从这里开始邀请同事加入工作区，也可以给外部协作者创建单群邀请。", "Start by inviting teammates to this workspace, or create a single-channel invite for an external collaborator.")}</p>
            </div>
            <button className="modal-close" onClick={() => setShowAddContact(false)} type="button">×</button>
          </div>
          <div className="modal-card__body">
            <p className="settings-panel-note">
              {tx("邀请加入整个工作区请前往设置 → 访问与邀请；如果只是拉外部协作者进某个群，可以在这里创建群邀请。", "Invite people into the whole workspace from Settings -> Access & Invitations. To invite an external collaborator into one channel, create a channel invitation here.")}
            </p>
            <label className="form-field form-field--full">
              <span>{tx("外部联系人邮箱", "External contact email")}</span>
              <input
                onChange={(event) => setExternalEmail(event.currentTarget.value)}
                placeholder="teammate@example.com"
                type="email"
                value={externalEmail}
              />
            </label>
            <label className="form-field form-field--full">
              <span>{tx("邀请加入群", "Invite to channel")}</span>
              <select
                disabled={channels.length === 0}
                onChange={(event) => setTargetChannel(event.currentTarget.value)}
                value={targetChannel}
              >
                {channels.map((channel) => (
                  <option key={channel} value={channel}>{channel}</option>
                ))}
              </select>
            </label>
            {inviteFeedback ? <p className="settings-feedback" role="status">{inviteFeedback}</p> : null}
            {latestInvitePath ? (
              <div className="settings-token-secret">
                <strong>{tx("群邀请链接", "Channel invite link")}</strong>
                <code>{latestInvitePath}</code>
              </div>
            ) : null}
          </div>
          <div className="modal-card__footer">
            <button className="action-button" onClick={() => setShowAddContact(false)} type="button">
              {tx("知道了", "Got it")}
            </button>
            <button
              className="primary-button"
              disabled={!externalEmail.trim() || !targetChannel}
              onClick={() => {
                void inviteExternalContactToChannelAction({
                  email: externalEmail,
                  channelName: targetChannel,
                })
                  .then((created) => {
                    setExternalEmail("");
                    setLatestInvitePath(resolveInviteUrl(created.invitePath));
                    setInviteFeedback(tx("群邀请已创建，等待对方接受。", "Channel invitation created; waiting for acceptance."));
                  })
                  .catch((error) => {
                    setInviteFeedback(error instanceof Error ? error.message : tx("邀请失败", "Invitation failed"));
                  });
              }}
              type="button"
            >
              {tx("创建群邀请", "Create channel invitation")}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function HumanContactChatHeader({
  backButton,
  contact,
  onCloseProfile,
  onToggleProfile,
  open,
  tx,
}: {
  backButton: ReactNode | null;
  contact: HumanContactItem;
  onCloseProfile: () => void;
  onToggleProfile: () => void;
  open: boolean;
  tx: (zh: string, en: string) => string;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      if (!popoverRef.current?.contains(event.target as Node)) {
        onCloseProfile();
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCloseProfile();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCloseProfile, open]);

  return (
    <header className="contacts-chat-header">
      <div className="contacts-chat-header__main">
        {backButton ? <div className="contacts-chat-header__leading">{backButton}</div> : null}
        <div className="human-contact-avatar-anchor" ref={popoverRef}>
          <button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={tx(`查看 ${contact.name} 的资料`, `View ${contact.name}'s profile`)}
            className="human-contact-avatar-button"
            onClick={onToggleProfile}
            type="button"
          >
            <GeneratedAvatar
              className="contacts-chat-header__avatar"
              id={contact.id}
              name={contact.name}
              variant="human"
            />
          </button>
          {open ? (
            <div
              aria-label={tx("联系人资料", "Contact profile")}
              className="human-contact-popover"
              role="dialog"
            >
              <div aria-hidden="true" className="human-contact-popover__arrow" />
              <HumanContactProfile contact={contact} tx={tx} />
            </div>
          ) : null}
        </div>
        <div>
          <h3>{contact.name}</h3>
          <p>{contact.subtitle}</p>
        </div>
      </div>
    </header>
  );
}

function HumanContactProfile({
  contact,
  tx,
}: {
  contact: HumanContactItem;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <section className="human-contacts-profile">
      <div className="human-contacts-profile__hero">
        <GeneratedAvatar
          className="human-contacts-profile__avatar"
          id={contact.id}
          name={contact.name}
          variant="human"
        />
        <div className="human-contacts-profile__copy">
          <strong>{contact.name}</strong>
          <p>{contact.subtitle}</p>
        </div>
      </div>

      <div className="human-contacts-profile__facts">
        <article className="human-contacts-profile__fact">
          <small>{tx("类型", "Type")}</small>
          <strong>{tx("工作区真人联系人", "Workspace human contact")}</strong>
        </article>
        <article className="human-contacts-profile__fact">
          <small>{tx("身份", "Role")}</small>
          <strong>{contact.role}</strong>
        </article>
        {contact.email ? (
          <article className="human-contacts-profile__fact">
            <small>{tx("邮箱", "Email")}</small>
            <strong>{contact.email}</strong>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function resolveInviteUrl(invitePath: string): string {
  if (typeof window === "undefined") {
    return invitePath;
  }
  return new URL(invitePath, window.location.origin).toString();
}
