// channels-page 共享类型与常量（3.4-3 拆分自 channels-page-client.tsx）。

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

export interface RecoverableDocumentDraft {
  documentId: string;
  title: string;
  summary: string;
  content: string;
}

export type ChannelWorkspaceTab = "messages" | "files" | "documents";
export type ChannelDocumentsView = "list" | "workspace";
export type ChannelDocumentCreateMode = "markdown" | "nativeSheet" | "nativeDeck";

export const CHANNEL_REFRESH_POLL_MS = 2000;
export const CHANNEL_REFRESH_STALE_LOCK_MS = 30_000;
export const CHANNEL_REALTIME_REFRESH_DEBOUNCE_MS = 350;
export const IM_PERFORMANCE_MARK_PREFIX = "dofe-agent.im";

export type ChannelRecord = ChannelsPageData["channels"][number];
export type ChannelDocumentRecord = ChannelsPageData["documents"][number];
export type ChannelFileRecord = ChannelsPageData["channelFiles"][number];
export type ChannelDocumentRunRecord = ChannelsPageData["documentRuns"][number];
export type ChannelDocumentConflictRecord = ChannelsPageData["documentConflicts"][number];
export type ChannelDetailData = Pick<ChannelsPageData, "channelFiles" | "detailScope" | "documentConflicts" | "documentRuns" | "documents" | "threads">;
export type FeishuChannelMemberSnapshot = NonNullable<NonNullable<ChannelRecord["feishu"]>["liveMembers"]>;

export interface ChannelPageIndexes {
  channelById: Map<string, ChannelRecord>;
  channelByFocusKey: Map<string, ChannelRecord>;
  threadByChannelName: Map<string, ChannelsPageData["threads"][number]>;
  documentsByChannelName: Map<string, ChannelDocumentRecord[]>;
  archivedDocumentsByChannelName: Map<string, ChannelDocumentRecord[]>;
  documentById: Map<string, ChannelDocumentRecord>;
  filesByChannelName: Map<string, ChannelFileRecord[]>;
  conflictById: Map<string, ChannelDocumentConflictRecord>;
  openConflictsByDocumentId: Map<string, ChannelDocumentConflictRecord[]>;
  runsByChannelName: Map<string, ChannelDocumentRunRecord[]>;
  mentionCandidatesByChannelName: Map<string, ChannelsPageData["mentionCandidates"]>;
  loadedDetailChannelNames: Set<string>;
}

export interface ChannelRouteState {
  focus: string | null;
  tab: ChannelWorkspaceTab | null;
  documentId: string | null;
  conversationView: "all" | "direct";
  communicationContext: "messages" | "contacts";
}

export interface ChannelRouteUpdateOptions {
  documentId?: string | null;
  tab?: ChannelWorkspaceTab;
}

export const EMPTY_CHANNEL_DOCUMENTS: ChannelDocumentRecord[] = [];
export const EMPTY_ARCHIVED_CHANNEL_DOCUMENTS: ChannelDocumentRecord[] = [];
export const EMPTY_CHANNEL_FILES: ChannelFileRecord[] = [];
export const EMPTY_DOCUMENT_CONFLICTS: ChannelDocumentConflictRecord[] = [];
export const EMPTY_DOCUMENT_RUNS: ChannelDocumentRunRecord[] = [];
export const EMPTY_MENTION_CANDIDATES: ChannelsPageData["mentionCandidates"] = [];
