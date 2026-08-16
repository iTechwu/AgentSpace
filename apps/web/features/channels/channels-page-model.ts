// channels-page 纯视图模型层：索引构建 / 详情缓存合并 / 路由解析 / 展示格式化（3.4-3 拆分）。

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

import type {
  ChannelDetailData,
  ChannelDocumentConflictRecord,
  ChannelDocumentCreateMode,
  ChannelDocumentRecord,
  ChannelDocumentRunRecord,
  ChannelFileRecord,
  ChannelPageIndexes,
  ChannelRecord,
  ChannelRouteState,
  ChannelWorkspaceTab,
  FeishuChannelMemberSnapshot,
} from "@/features/channels/channels-page-shared";

export function buildChannelsPageIndexes(data: ChannelsPageData): ChannelPageIndexes {
  const channelById = new Map<string, ChannelRecord>();
  const channelByFocusKey = new Map<string, ChannelRecord>();
  const threadByChannelName = new Map<string, ChannelsPageData["threads"][number]>();
  const documentsByChannelName = new Map<string, ChannelDocumentRecord[]>();
  const archivedDocumentsByChannelName = new Map<string, ChannelDocumentRecord[]>();
  const documentById = new Map<string, ChannelDocumentRecord>();
  const filesByChannelName = new Map<string, ChannelFileRecord[]>();
  const conflictById = new Map<string, ChannelDocumentConflictRecord>();
  const openConflictsByDocumentId = new Map<string, ChannelDocumentConflictRecord[]>();
  const runsByChannelName = new Map<string, ChannelDocumentRunRecord[]>();
  const mentionCandidatesByChannelName = new Map<string, ChannelsPageData["mentionCandidates"]>();

  for (const channel of data.channels) {
    channelById.set(channel.id, channel);
    channelByFocusKey.set(`channel:${channel.id}`, channel);
    if (channel.channelName) {
      channelByFocusKey.set(`channel:${channel.channelName}`, channel);
    }
    if (channel.kind === "direct" && channel.contactId) {
      channelByFocusKey.set(`contact:${channel.contactId}`, channel);
    }
    if (channel.kind === "direct" && channel.humanContactUserId) {
      channelByFocusKey.set(`human:${channel.humanContactUserId}`, channel);
    }
  }

  for (const thread of data.threads) {
    threadByChannelName.set(thread.channelName, thread);
  }

  for (const document of data.documents) {
    const byChannel =
      document.status === "archived" ? archivedDocumentsByChannelName : documentsByChannelName;
    const documents = byChannel.get(document.channelName);
    if (documents) {
      documents.push(document);
    } else {
      byChannel.set(document.channelName, [document]);
    }
    documentById.set(document.id, document);
  }

  for (const file of data.channelFiles) {
    const files = filesByChannelName.get(file.channelName);
    if (files) {
      files.push(file);
    } else {
      filesByChannelName.set(file.channelName, [file]);
    }
  }

  for (const conflict of data.documentConflicts) {
    conflictById.set(conflict.id, conflict);
    if (conflict.status !== "open") {
      continue;
    }
    const conflicts = openConflictsByDocumentId.get(conflict.documentId);
    if (conflicts) {
      conflicts.push(conflict);
    } else {
      openConflictsByDocumentId.set(conflict.documentId, [conflict]);
    }
  }

  for (const run of data.documentRuns) {
    const runs = runsByChannelName.get(run.channelName);
    if (runs) {
      runs.push(run);
    } else {
      runsByChannelName.set(run.channelName, [run]);
    }
  }

  for (const candidate of data.mentionCandidates) {
    for (const channelName of candidate.channels) {
      const candidates = mentionCandidatesByChannelName.get(channelName);
      if (candidates) {
        candidates.push(candidate);
      } else {
        mentionCandidatesByChannelName.set(channelName, [candidate]);
      }
    }
  }

  const loadedDetailChannelNames = new Set(data.detailScope ?? data.threads.map((thread) => thread.channelName));
  if (!data.detailScope) {
    for (const channel of data.channels) {
      const detailChannelName = resolveSelectedChannelName(channel);
      if (detailChannelName) {
        loadedDetailChannelNames.add(detailChannelName);
      }
    }
  }

  return {
    channelById,
    channelByFocusKey,
    threadByChannelName,
    documentsByChannelName,
    archivedDocumentsByChannelName,
    documentById,
    filesByChannelName,
    conflictById,
    openConflictsByDocumentId,
    runsByChannelName,
    mentionCandidatesByChannelName,
    loadedDetailChannelNames,
  };
}

export function buildInitialChannelDetailCache(data: ChannelsPageData): Map<string, ChannelDetailData> {
  const channelNames = data.detailScope ?? data.channels
    .map((channel) => resolveSelectedChannelName(channel))
    .filter((channelName): channelName is string => Boolean(channelName));
  return buildDetailCacheForChannels(data, channelNames);
}

export function mergeChannelsPageDataWithDetailCache(
  data: ChannelsPageData,
  detailDataByChannelName: Map<string, ChannelDetailData>,
): ChannelsPageData {
  if (detailDataByChannelName.size === 0) {
    return data;
  }

  const cachedChannelNames = new Set(detailDataByChannelName.keys());
  const cachedThreads = new Map<string, ChannelsPageData["threads"][number]>();
  const cachedDocuments: ChannelDocumentRecord[] = [];
  const cachedDocumentRuns: ChannelDocumentRunRecord[] = [];
  const cachedChannelFiles: ChannelFileRecord[] = [];
  const cachedDocumentConflicts: ChannelDocumentConflictRecord[] = [];
  const cachedDetailScope = new Set(data.detailScope ?? []);
  const cachedDocumentIds = new Set<string>();

  for (const [channelName, detail] of detailDataByChannelName) {
    cachedDetailScope.add(channelName);
    for (const thread of detail.threads) {
      cachedThreads.set(thread.channelName, thread);
    }
    for (const document of detail.documents) {
      if (document.channelName === channelName) {
        cachedDocuments.push(document);
        cachedDocumentIds.add(document.id);
      }
    }
    for (const run of detail.documentRuns) {
      if (run.channelName === channelName) {
        cachedDocumentRuns.push(run);
      }
    }
    for (const file of detail.channelFiles) {
      if (file.channelName === channelName) {
        cachedChannelFiles.push(file);
      }
    }
  }

  for (const detail of detailDataByChannelName.values()) {
    for (const conflict of detail.documentConflicts) {
      if (cachedDocumentIds.has(conflict.documentId)) {
        cachedDocumentConflicts.push(conflict);
      }
    }
  }

  const cachedConflictIds = new Set(cachedDocumentConflicts.map((conflict) => conflict.id));
  const documentIdsByChannelName = new Map<string, Set<string>>();
  for (const document of data.documents) {
    if (!cachedChannelNames.has(document.channelName)) {
      continue;
    }
    const documentIds = documentIdsByChannelName.get(document.channelName) ?? new Set<string>();
    documentIds.add(document.id);
    documentIdsByChannelName.set(document.channelName, documentIds);
  }
  for (const document of cachedDocuments) {
    const documentIds = documentIdsByChannelName.get(document.channelName) ?? new Set<string>();
    documentIds.add(document.id);
    documentIdsByChannelName.set(document.channelName, documentIds);
  }
  const replacedDocumentIds = new Set(
    [...documentIdsByChannelName.values()].flatMap((documentIds) => [...documentIds]),
  );
  const seenThreadNames = new Set<string>();
  const mergedThreads = data.threads.map((thread) => {
    seenThreadNames.add(thread.channelName);
    return cachedThreads.get(thread.channelName) ?? thread;
  });
  for (const [threadName, thread] of cachedThreads) {
    if (!seenThreadNames.has(threadName)) {
      mergedThreads.push(thread);
    }
  }

  return {
    ...data,
    threads: mergedThreads,
    documents: [
      ...data.documents.filter((document) => !cachedChannelNames.has(document.channelName)),
      ...cachedDocuments,
    ],
    documentRuns: [
      ...data.documentRuns.filter((run) => !cachedChannelNames.has(run.channelName)),
      ...cachedDocumentRuns,
    ],
    documentConflicts: [
      ...data.documentConflicts.filter(
        (conflict) => !cachedConflictIds.has(conflict.id) && !replacedDocumentIds.has(conflict.documentId),
      ),
      ...cachedDocumentConflicts,
    ],
    channelFiles: [
      ...data.channelFiles.filter((file) => !cachedChannelNames.has(file.channelName)),
      ...cachedChannelFiles,
    ],
    detailScope: data.detailScope ? [...cachedDetailScope] : undefined,
  };
}

export function buildDetailCacheForChannels(
  data: ChannelDetailData,
  channelNames: Iterable<string>,
): Map<string, ChannelDetailData> {
  const cache = new Map<string, ChannelDetailData>();

  for (const channelName of channelNames) {
    const documents = data.documents.filter((document) => document.channelName === channelName);
    const documentIds = new Set(documents.map((document) => document.id));
    cache.set(channelName, {
      threads: data.threads.filter(
        (thread) =>
          thread.channelName === channelName ||
          thread.messages.some((message) => message.channel === channelName),
      ),
      documents,
      documentRuns: data.documentRuns.filter((run) => run.channelName === channelName),
      documentConflicts: data.documentConflicts.filter((conflict) => documentIds.has(conflict.documentId)),
      channelFiles: data.channelFiles.filter((file) => file.channelName === channelName),
      detailScope: [channelName],
    });
  }

  return cache;
}

export function resolveSelectedChannelName(channel: ChannelsPageData["channels"][number] | null): string | null {
  if (!channel) {
    return null;
  }
  if (typeof channel.channelName === "string" && channel.channelName.length > 0) {
    return channel.channelName;
  }
  return channel.kind === "direct" ? null : channel.name;
}

export function buildImChannelDetailResourceKey(channelName: string): string {
  return `channel-detail:${channelName}`;
}

export function buildImChannelDetailCacheMetadata(detail: ChannelDetailData, fallbackChannelName: string) {
  const channelNames = new Set<string>(
    [fallbackChannelName, ...(detail.detailScope ?? [])]
      .map((channelName) => channelName.trim())
      .filter(Boolean),
  );
  for (const thread of detail.threads) {
    channelNames.add(thread.channelName);
    for (const message of thread.messages) {
      if (message.channel) {
        channelNames.add(message.channel);
      }
    }
  }
  for (const document of detail.documents) {
    channelNames.add(document.channelName);
  }
  for (const run of detail.documentRuns) {
    channelNames.add(run.channelName);
  }
  for (const file of detail.channelFiles) {
    channelNames.add(file.channelName);
  }

  return {
    resourceRefs: {
      channel: [...channelNames],
      document: detail.documents.map((document) => document.id),
    },
  };
}

export function isImPerformanceInstrumentationEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    typeof window.performance?.mark === "function" &&
    typeof window.performance?.measure === "function"
  );
}

export function buildDocumentDraftSource(document: ChannelDocumentRecord): string {
  return `${document.id}:${document.currentVersionId}`;
}

export function parseChannelWorkspaceTab(value: string | null): ChannelWorkspaceTab | null {
  return value === "messages" || value === "files" || value === "documents" ? value : null;
}

export function parseChannelRouteState(routeSearch: string): ChannelRouteState {
  const searchParams = new URLSearchParams(routeSearch);
  const documentId = searchParams.get("doc");
  return {
    focus: searchParams.get("focus"),
    tab: parseChannelWorkspaceTab(searchParams.get("tab")),
    documentId,
    conversationView: searchParams.get("view") === "direct" ? "direct" : "all",
    communicationContext: searchParams.get("context") === "contacts" ? "contacts" : "messages",
  };
}

export function resolveInitialSelectedChannelId(channels: ChannelRecord[], routeSearch: string): string | null {
  const focus = new URLSearchParams(routeSearch).get("focus");
  if (focus) {
    const focusedChannel = channels.find((channel) => {
      if (focus === `channel:${channel.id}` || focus === `channel:${channel.channelName ?? channel.id}`) {
        return true;
      }
      if (channel.kind === "direct" && channel.contactId && focus === `contact:${channel.contactId}`) {
        return true;
      }
      return channel.kind === "direct"
        && Boolean(channel.humanContactUserId)
        && focus === `human:${channel.humanContactUserId}`;
    });
    if (focusedChannel) {
      return focusedChannel.id;
    }
  }
  return channels[0]?.id ?? null;
}

export function buildChannelFocusValue(channel: ChannelRecord | undefined, fallbackChannelId: string): string {
  if (channel?.kind === "direct" && channel.contactId) {
    return `contact:${channel.contactId}`;
  }
  if (channel?.kind === "direct" && channel.humanContactUserId) {
    return `human:${channel.humanContactUserId}`;
  }
  return `channel:${channel?.channelName ?? fallbackChannelId}`;
}

export function readCurrentChannelSearchParams(fallbackSearch: string): URLSearchParams {
  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search);
  }
  return new URLSearchParams(fallbackSearch);
}

export function normalizeMemberKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function buildInitialDocumentDraftContent(
  mode: ChannelDocumentCreateMode,
  tx: (zh: string, en: string) => string,
): string {
  if (mode === "nativeSheet") {
    return [
      `| ${tx("项目", "Item")} | Owner | ${tx("状态", "Status")} |`,
      "|---|---|---|",
      `| ${tx("待补充", "To fill")} |  | ${tx("未开始", "Not started")} |`,
    ].join("\n");
  }

  if (mode === "nativeDeck") {
    return [
      `# ${tx("演示文稿标题", "Deck title")}`,
      "",
      "---",
      "",
      `## ${tx("第一页标题", "First slide title")}`,
      "",
      `- ${tx("要点", "Point")}`,
      `- ${tx("下一步", "Next step")}`,
    ].join("\n");
  }

  return "";
}

export function resolveDocumentKindForCreateMode(mode: ChannelDocumentCreateMode): "markdown" | "sheet" | "deck" {
  if (mode === "nativeSheet") {
    return "sheet";
  }
  if (mode === "nativeDeck") {
    return "deck";
  }
  return "markdown";
}

export function isStaleChannelDocumentSaveError(message: string): boolean {
  return /updated by someone else/i.test(message);
}

export function translateChannelPreview(
  channelId: string,
  threadByChannelName: Map<string, ChannelsPageData["threads"][number]>,
  tx: (zh: string, en: string) => string,
): string | undefined {
  const thread = threadByChannelName.get(channelId);
  const latest = thread?.messages.at(-1);
  if (!latest) {
    return undefined;
  }
  return truncateChannelPreview(
    `${translateSystemSpeaker(latest.speaker, tx)}: ${translateWorkspaceMessageSummary(
      {
        summary: latest.summary,
        code: latest.code,
        data: latest.data,
      },
      tx,
    )}`,
  );
}

export function translateChannelAccessPreview(
  accessState: ChannelsPageData["channels"][number]["accessState"],
  tx: (zh: string, en: string) => string,
): string | undefined {
  if (accessState === "pending") {
    return tx("已申请加入，等待管理员审批", "Access requested, waiting for admin approval");
  }
  if (accessState === "requestable") {
    return tx("目录可见，申请后才能查看消息", "Directory visible. Request access to read messages");
  }
  return undefined;
}

export function translateChannelListPreview(
  lastMessage: string | undefined,
  tx: (zh: string, en: string) => string,
): string | undefined {
  if (!lastMessage?.trim()) {
    return undefined;
  }
  return truncateChannelPreview(
    translateWorkspaceMessageSummary(
      {
        summary: lastMessage,
      },
      tx,
    ),
  );
}

export function truncateChannelPreview(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 180) {
    return trimmed;
  }
  return `${trimmed.slice(0, 177)}...`;
}

export function estimateChannelMemberCount(memberLabel: string): number {
  const counts = Array.from(memberLabel.matchAll(/\d+/g))
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
  return counts.slice(0, 2).reduce((sum, value) => sum + value, 0);
}

export function applyLiveFeishuMemberSnapshot(
  channel: ChannelRecord | null,
  snapshot: FeishuChannelMemberSnapshot | undefined,
): ChannelRecord | null {
  if (!channel || !channel.feishu) {
    return channel;
  }

  const displayName = snapshot?.chatName || channel.feishu.externalChatName?.trim() || channel.displayName;
  if (!snapshot && displayName === channel.displayName) {
    return channel;
  }

  return {
    ...channel,
    displayName,
    ...(snapshot ? {
      memberCount: snapshot.userCount + snapshot.botCount,
      memberLabel: `${snapshot.userCount} humans / ${snapshot.botCount} bots`,
    } : {}),
    feishu: {
      ...channel.feishu,
      ...(snapshot?.chatName ? { externalChatName: snapshot.chatName } : {}),
      ...(snapshot ? { liveMembers: snapshot } : {}),
    },
  };
}

export function formatChannelWorkspaceTime(value?: string): string {
  return formatCompactTimestamp(value, { emptyFallback: "—" });
}

export function formatChannelFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
