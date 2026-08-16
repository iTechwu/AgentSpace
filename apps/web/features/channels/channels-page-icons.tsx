"use client";

// channels-page 内联图标组件（3.4-3 拆分自 channels-page-client.tsx）。

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

export function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M13.5 13.5L18 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function VideoIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect height="11" rx="2" stroke="currentColor" strokeWidth="1.8" width="10" x="2.5" y="4.5" />
      <path d="M12.5 8L17 5.5V14.5L12.5 12" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

export function UserPlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <circle cx="8" cy="6.5" r="2.7" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 15.5C4.2 12.8 6.1 11.5 8 11.5C9.9 11.5 11.8 12.8 12.5 15.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M15 6V12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M12 9H18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect height="13" rx="2" stroke="currentColor" strokeWidth="1.8" width="13" x="3.5" y="4.5" />
      <path d="M6.5 2.5V6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M13.5 2.5V6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M3.5 8H16.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 20 20">
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
    </svg>
  );
}

export function MessageBubbleIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M5 5.5H15C16.1 5.5 17 6.4 17 7.5V11.5C17 12.6 16.1 13.5 15 13.5H10L6.2 16.2C5.8 16.5 5.2 16.2 5.2 15.7V13.5H5C3.9 13.5 3 12.6 3 11.5V7.5C3 6.4 3.9 5.5 5 5.5Z" fill="currentColor" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M2.5 6.5C2.5 5.4 3.4 4.5 4.5 4.5H8L9.7 6H15.5C16.6 6 17.5 6.9 17.5 8V13.5C17.5 14.6 16.6 15.5 15.5 15.5H4.5C3.4 15.5 2.5 14.6 2.5 13.5V6.5Z" fill="currentColor" />
    </svg>
  );
}

export function CloudDocIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect fill="currentColor" height="14" rx="2.5" width="11" x="3" y="3" />
      <path d="M7 7H11" stroke="#fff" strokeLinecap="round" strokeWidth="1.6" />
      <path d="M7 10H11" stroke="#fff" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="14.5" cy="13.5" fill="#5cc58d" r="3.5" />
      <path d="M12.8 13.5H16.2" stroke="#fff" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

export function SheetIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect fill="currentColor" height="14" rx="2.5" width="14" x="3" y="3" />
      <path d="M7 3V17M13 3V17M3 8H17M3 13H17" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

export function AddCardIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect height="11" rx="2" stroke="currentColor" strokeWidth="1.7" width="12" x="4" y="4.5" />
      <path d="M10 7.5V12.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
      <path d="M7.5 10H12.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M4 13.8L13.5 4.3L15.7 6.5L6.2 16H4V13.8Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M5 6H15" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
      <path d="M7 6V4.8C7 4.1 7.6 3.5 8.3 3.5H11.7C12.4 3.5 13 4.1 13 4.8V6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6.2 6L6.8 15.2C6.8 15.9 7.4 16.5 8.1 16.5H11.9C12.6 16.5 13.2 15.9 13.2 15.2L13.8 6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
