// channels-page 共享类型与常量（3.4-3 拆分自 channels-page-client.tsx）。

import type { ChannelsPageData } from "@/features/dashboard/data";

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
  isNewConversation: boolean;
  /** 多会话拆分：稳定 URL 中的 conversation=<id>。 */
  conversationId: string | null;
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
