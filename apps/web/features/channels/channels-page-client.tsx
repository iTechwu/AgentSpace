"use client";


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
  translateRuntimeFailureSummary,
  translateSystemSpeaker,
  translateWorkspaceMessageSummary,
} from "@/features/i18n/presentation";

import {
  CHANNEL_REFRESH_POLL_MS,
  CHANNEL_REFRESH_STALE_LOCK_MS,
  EMPTY_ARCHIVED_CHANNEL_DOCUMENTS,
  EMPTY_CHANNEL_DOCUMENTS,
  EMPTY_CHANNEL_FILES,
  EMPTY_DOCUMENT_CONFLICTS,
  EMPTY_DOCUMENT_RUNS,
  EMPTY_MENTION_CANDIDATES,
  IM_PERFORMANCE_MARK_PREFIX,
} from "@/features/channels/channels-page-shared";
import type {
  ChannelDetailData,
  ChannelDocumentCreateMode,
  ChannelDocumentsView,
  ChannelWorkspaceTab,
  FeishuChannelMemberSnapshot,
  RecoverableDocumentDraft,
} from "@/features/channels/channels-page-shared";
import {
  applyLiveFeishuMemberSnapshot,
  buildChannelFocusValue,
  buildChannelsPageIndexes,
  buildDocumentDraftSource,
  buildImChannelDetailCacheMetadata,
  buildImChannelDetailResourceKey,
  buildInitialChannelDetailCache,
  buildInitialDocumentDraftContent,
  estimateChannelMemberCount,
  isImPerformanceInstrumentationEnabled,
  isStaleChannelDocumentSaveError,
  mergeChannelsPageDataWithDetailCache,
  normalizeMemberKey,
  resolveDocumentKindForCreateMode,
  resolveInitialSelectedChannelId,
  resolveSelectedChannelName,
  translateChannelAccessPreview,
  translateChannelListPreview,
  translateChannelPreview,
} from "@/features/channels/channels-page-model";
import {
  useChannelRealtimeRefresh,
  useChannelRouteState,
} from "@/features/channels/channels-page-hooks";
import {
  AddChannelMembersModal,
  DigitalContactRemarkModal,
  RenameChannelModal,
} from "@/features/channels/channels-page-modals";
import {
  ChannelAccessGate,
  ChannelDetailErrorState,
  ChannelDetailLoadingState,
  ChannelDocumentsOverview,
  ChannelFilesView,
  DigitalEmployeeDirectoryDetail,
  DigitalEmployeeDirectoryHeader,
} from "@/features/channels/channels-page-views";
import {
  ChannelWorkspaceHeader,
  canRenameChannelFromHeader,
} from "@/features/channels/channel-workspace-header";

export function ChannelsPageClient({
  data,
  currentUserDisplayName,
  moduleSearchParams,
  onDataChanged,
  onInvalidation,
}: {
  data: ChannelsPageData;
  currentUserDisplayName: string;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { navigateWorkspaceModule } = useWorkspaceModuleNavigation();
  const moduleCache = useOptionalWorkspaceModuleCache();
  useWorkspaceModuleCacheRevision();
  const moduleCacheScope = useWorkspaceModuleCacheScope();
  const { pushToast } = useFeedbackToast();
  const pathname = usePathname();
  const { workspaceSlug } = parseWorkspacePathname(pathname);
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const searchParamText = searchParams.toString();
  const [routeSearch, setRouteSearch] = useState(searchParamText);
  const workspaceHref = useCallback(
    (path: string): string => {
      const workspaceIdentifier = data.workspaceId ?? workspaceSlug;
      return workspaceIdentifier ? buildWorkspacePath(workspaceIdentifier, path) : path;
    },
    [data.workspaceId, workspaceSlug],
  );
  const navigateToWorkspaceModule = useCallback((path: string) => {
    const href = workspaceHref(path);
    if (navigateWorkspaceModule(href)) {
      return;
    }
    router.push(href);
  }, [navigateWorkspaceModule, router, workspaceHref]);
  const replaceWorkspaceModule = useCallback((path: string) => {
    const href = workspaceHref(path);
    if (navigateWorkspaceModule(href, { replace: true })) {
      return;
    }
    router.replace(href, { scroll: false });
  }, [navigateWorkspaceModule, router, workspaceHref]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(() =>
    resolveInitialSelectedChannelId(data.channels, searchParamText),
  );
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [activeTab, setActiveTab] = useState<ChannelWorkspaceTab>("messages");
  const [documentsView, setDocumentsView] = useState<ChannelDocumentsView>("list");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [isCreatingDocument, setIsCreatingDocument] = useState(false);
  const [documentCreateMode, setDocumentCreateMode] = useState<ChannelDocumentCreateMode>("markdown");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [documentFeedback, setDocumentFeedback] = useState<string | null>(null);
  const [fileFeedback, setFileFeedback] = useState<string | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<RecoverableDocumentDraft | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showContactRemarkEditor, setShowContactRemarkEditor] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showModelCommandDialog, setShowModelCommandDialog] = useState(false);
  const [addMembersFeedback, setAddMembersFeedback] = useState<string | null>(null);
  const [accessRequestFeedback, setAccessRequestFeedback] = useState<string | null>(null);
  const [detailDataByChannelName, setDetailDataByChannelName] = useState<Map<string, ChannelDetailData>>(() =>
    buildInitialChannelDetailCache(data),
  );
  const [feishuMemberSnapshotByChannelName, setFeishuMemberSnapshotByChannelName] = useState<Map<string, FeishuChannelMemberSnapshot>>(
    () => new Map(),
  );
  const [loadingDetailChannelName, setLoadingDetailChannelName] = useState<string | null>(null);
  const [detailLoadError, setDetailLoadError] = useState<string | null>(null);
  const [openMontageRefreshVersion, setOpenMontageRefreshVersion] = useState(0);
  const [hasOpenMontageJobs, setHasOpenMontageJobs] = useState(false);
  const [composerExecutionPolicyOverrides, setComposerExecutionPolicyOverrides] = useState<
    Map<string, EmployeeExecutionPolicy | null>
  >(() => new Map());
  const [isPending, startTransition] = useTransition();
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  const documentSearchInputRef = useRef<HTMLInputElement>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const initialRenderMeasuredRef = useRef(false);
  const dataSizeSignatureRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshMeasurementPendingRef = useRef(false);
  const refreshResetTimerRef = useRef<number | null>(null);
  const transitionPendingRef = useRef(false);
  const documentDraftSourceRef = useRef<string | null>(null);
  const unavailableFeishuChannelNamesRef = useRef(new Set<string>());
  const markImChannelDetailCacheStale = useCallback((channelName?: string | null) => {
    setDetailDataByChannelName((current) => {
      if (!channelName) {
        return current.size === 0 ? current : new Map();
      }
      if (!current.has(channelName)) {
        return current;
      }
      const next = new Map(current);
      next.delete(channelName);
      return next;
    });
    if (!moduleCache) {
      return;
    }
    const resourceKey = channelName ? buildImChannelDetailResourceKey(channelName) : null;
    moduleCache.markStale((entry) =>
      entry.metadata.workspaceId === data.workspaceId &&
      entry.metadata.moduleId === "im" &&
      (resourceKey
        ? entry.metadata.resourceKey === resourceKey
        : entry.metadata.resourceKey?.startsWith("channel-detail:") === true),
    );
  }, [data.workspaceId, moduleCache]);
  const refreshChannelModule = useCallback((channelName?: string | null) => {
    markImChannelDetailCacheStale(channelName);
    refreshWorkspaceModule(onDataChanged, router);
  }, [markImChannelDetailCacheStale, onDataChanged, router]);
  const buildChannelDetailCacheKey = useCallback((channelName: string) =>
    scopeWorkspaceModuleCacheKey(
      {
        workspaceId: data.workspaceId,
        moduleId: "im",
        resourceKey: buildImChannelDetailResourceKey(channelName),
      },
      moduleCacheScope,
    ), [data.workspaceId, moduleCacheScope]);
  const mergedData = useMemo(
    () => mergeChannelsPageDataWithDetailCache(data, detailDataByChannelName),
    [data, detailDataByChannelName],
  );
  const indexes = useMemo(() => buildChannelsPageIndexes(mergedData), [mergedData]);
  const {
    routeState,
    replaceChannelRoute,
    pushChannelRoute,
  } = useChannelRouteState({
    activeTab,
    channelById: indexes.channelById,
    navigateWorkspaceModule,
    routeSearch,
    setRouteSearch,
    workspaceHref,
  });
  const conversationView = routeState.conversationView;
  const isContactDirectoryContext = routeState.communicationContext === "contacts";
  const dataSizeSnapshot = useMemo(
    () => ({
      channels: data.channels.length,
      threads: mergedData.threads.length,
      messages: mergedData.threads.reduce((count, thread) => count + thread.messages.length, 0),
      documents: mergedData.documents.length,
      documentRuns: mergedData.documentRuns.length,
      documentConflicts: mergedData.documentConflicts.length,
      channelFiles: mergedData.channelFiles.length,
    }),
    [data.channels.length, mergedData],
  );
  const markInteraction = useCallback((name: string) => {
    if (!isImPerformanceInstrumentationEnabled()) {
      return;
    }
    window.performance.mark(`${IM_PERFORMANCE_MARK_PREFIX}.${name}.start`);
  }, []);
  const measureInteraction = useCallback((name: string) => {
    if (!isImPerformanceInstrumentationEnabled()) {
      return;
    }
    const startMark = `${IM_PERFORMANCE_MARK_PREFIX}.${name}.start`;
    const endMark = `${IM_PERFORMANCE_MARK_PREFIX}.${name}.end`;
    window.requestAnimationFrame(() => {
      window.performance.mark(endMark);
      try {
        window.performance.measure(`${IM_PERFORMANCE_MARK_PREFIX}.${name}`, startMark, endMark);
      } catch {
        return;
      }
      const measure = window.performance.getEntriesByName(`${IM_PERFORMANCE_MARK_PREFIX}.${name}`).at(-1);
      if (measure) {
        console.debug(`[im:perf] ${name} ${Math.round(measure.duration)}ms`);
      }
      window.performance.clearMarks(startMark);
      window.performance.clearMarks(endMark);
      window.performance.clearMeasures(`${IM_PERFORMANCE_MARK_PREFIX}.${name}`);
    });
  }, []);
  useEffect(() => {
    transitionPendingRef.current = isPending;
  }, [isPending]);

  useEffect(() => () => {
    if (refreshResetTimerRef.current !== null) {
      window.clearTimeout(refreshResetTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isImPerformanceInstrumentationEnabled() || initialRenderMeasuredRef.current) {
      return;
    }
    initialRenderMeasuredRef.current = true;
    const startMark = `${IM_PERFORMANCE_MARK_PREFIX}.initial-render.start`;
    const endMark = `${IM_PERFORMANCE_MARK_PREFIX}.initial-render.end`;
    window.performance.mark(startMark);
    window.requestAnimationFrame(() => {
      window.performance.mark(endMark);
      window.performance.measure(`${IM_PERFORMANCE_MARK_PREFIX}.initial-render`, startMark, endMark);
      const measure = window.performance.getEntriesByName(`${IM_PERFORMANCE_MARK_PREFIX}.initial-render`).at(-1);
      if (measure) {
        console.debug(`[im:perf] initial-render ${Math.round(measure.duration)}ms`);
      }
      window.performance.clearMarks(startMark);
      window.performance.clearMarks(endMark);
      window.performance.clearMeasures(`${IM_PERFORMANCE_MARK_PREFIX}.initial-render`);
    });
  }, []);

  useEffect(() => {
    if (!isImPerformanceInstrumentationEnabled()) {
      return;
    }
    const signature = JSON.stringify(dataSizeSnapshot);
    if (dataSizeSignatureRef.current === signature) {
      return;
    }
    dataSizeSignatureRef.current = signature;
    console.debug("[im:perf] data sizes", dataSizeSnapshot);
  }, [dataSizeSnapshot]);

  useEffect(
    () => () => {
      if (refreshResetTimerRef.current !== null) {
        window.clearTimeout(refreshResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setRouteSearch(searchParamText);
  }, [searchParamText]);

  useEffect(() => {
    const initialDetailCache = buildInitialChannelDetailCache(data);
    if (moduleCache) {
      for (const [channelName, detail] of initialDetailCache) {
        moduleCache.set(
          buildChannelDetailCacheKey(channelName),
          detail,
          buildImChannelDetailCacheMetadata(detail, channelName),
        );
      }
    }

    setDetailDataByChannelName((current) => {
      const next = new Map(current);
      let changed = false;
      for (const [channelName, detail] of initialDetailCache) {
        next.set(channelName, detail);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [buildChannelDetailCacheKey, data, moduleCache]);

  useEffect(() => {
    function handlePopState(): void {
      setRouteSearch(window.location.search.replace(/^\?/, ""));
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const nextTab = routeState.tab ?? (routeState.documentId ? "documents" : "messages");
    if (!routeState.focus) {
      if (routeState.tab || routeState.documentId) {
        setActiveTab(nextTab);
        setDocumentsView(nextTab === "documents" && routeState.documentId ? "workspace" : "list");
      }
      if (routeState.documentId) {
        setSelectedDocumentId(routeState.documentId);
      }
      return;
    }

    const focusedChannel = indexes.channelByFocusKey.get(routeState.focus);
    if (focusedChannel) {
      setSelectedChannelId(focusedChannel.id);
    }
    setActiveTab(nextTab);
    setDocumentsView(nextTab === "documents" && routeState.documentId ? "workspace" : "list");
    if (routeState.documentId) {
      setSelectedDocumentId(routeState.documentId);
    }
  }, [indexes, routeState]);

  const visibleChannels = useMemo(
    () => {
      const imChannels = mergedData.channels.filter((channel) => channel.directParticipantKind !== "human");
      return conversationView === "direct"
        ? imChannels.filter((channel) => channel.kind === "direct")
        : imChannels;
    },
    [conversationView, mergedData.channels],
  );
  const visibleChannelById = useMemo(
    () => new Map(visibleChannels.map((channel) => [channel.id, channel])),
    [visibleChannels],
  );
  const visibleFeishuGroupChannelNames = useMemo(
    () => visibleChannels
      .filter((channel) => channel.kind !== "direct" && Boolean(channel.feishu))
      .map((channel) => channel.name),
    [visibleChannels],
  );

  useEffect(() => {
    if (!selectedChannelId || !visibleChannelById.has(selectedChannelId)) {
      setSelectedChannelId(visibleChannels[0]?.id ?? null);
    }
  }, [selectedChannelId, visibleChannelById, visibleChannels]);

  useEffect(() => {
    setAccessRequestFeedback(null);
    setFileFeedback(null);
    setShowModelCommandDialog(false);
  }, [selectedChannelId]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent): void {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) {
        setShowHeaderMenu(false);
      }
      if (createMenuRef.current && !createMenuRef.current.contains(event.target as Node)) {
        setShowCreateMenu(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const selectedChannel = selectedChannelId ? visibleChannelById.get(selectedChannelId) ?? null : null;
  const selectedConversationChannelName = resolveSelectedChannelName(selectedChannel);
  const selectedFeishuMemberSnapshot = selectedChannel?.feishu
    ? feishuMemberSnapshotByChannelName.get(selectedChannel.name) ?? undefined
    : undefined;
  const selectedChannelWithLiveFeishuMembers = useMemo(
    () => applyLiveFeishuMemberSnapshot(selectedChannel, selectedFeishuMemberSnapshot),
    [selectedChannel, selectedFeishuMemberSnapshot],
  );
  const refreshChannelData = useCallback((options?: { allowWhileInputActive?: boolean }) => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    if (!options?.allowWhileInputActive && isDocumentInputActive()) {
      return;
    }
    if (refreshInFlightRef.current || transitionPendingRef.current) {
      return;
    }
    markInteraction("refresh");
    refreshMeasurementPendingRef.current = true;
    refreshInFlightRef.current = true;
    startTransition(() => {
      refreshChannelModule(selectedConversationChannelName);
    });
    if (refreshResetTimerRef.current !== null) {
      window.clearTimeout(refreshResetTimerRef.current);
    }
    refreshResetTimerRef.current = window.setTimeout(() => {
      refreshInFlightRef.current = false;
      refreshResetTimerRef.current = null;
      if (refreshMeasurementPendingRef.current) {
        refreshMeasurementPendingRef.current = false;
        measureInteraction("refresh");
      }
    }, CHANNEL_REFRESH_STALE_LOCK_MS);
  }, [markInteraction, refreshChannelModule, selectedConversationChannelName]);
  const selectedChannelCanRename = selectedChannel
    ? canRenameChannelFromHeader(selectedChannel)
    : false;
  const selectedChannelRequiresAccess =
    selectedChannel?.kind !== "direct"
    && selectedChannel?.accessState !== undefined
    && selectedChannel.accessState !== "accessible";

  useEffect(() => {
    const pendingChannelNames = visibleFeishuGroupChannelNames.filter(
      (channelName) =>
        !feishuMemberSnapshotByChannelName.has(channelName) &&
        !unavailableFeishuChannelNamesRef.current.has(channelName),
    );
    if (pendingChannelNames.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(
      pendingChannelNames.map(async (channelName) => ({
        channelName,
        snapshot: await getFeishuChannelMemberSnapshotAction({
          channelName,
          workspaceId: data.workspaceId,
        }).catch(() => null),
      })),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      const successfulResults = results.filter(
        (result): result is { channelName: string; snapshot: FeishuChannelMemberSnapshot } => Boolean(result.snapshot),
      );
      for (const result of results) {
        if (!result.snapshot) {
          unavailableFeishuChannelNamesRef.current.add(result.channelName);
        }
      }
      if (successfulResults.length === 0) {
        return;
      }
      setFeishuMemberSnapshotByChannelName((current) => {
        const next = new Map(current);
        for (const result of successfulResults) {
          next.set(result.channelName, result.snapshot);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    data.workspaceId,
    feishuMemberSnapshotByChannelName,
    visibleFeishuGroupChannelNames,
  ]);
  const selectedThread = selectedConversationChannelName
    ? indexes.threadByChannelName.get(selectedConversationChannelName) ?? null
    : null;
  const channelDocuments = selectedConversationChannelName
    ? indexes.documentsByChannelName.get(selectedConversationChannelName) ?? EMPTY_CHANNEL_DOCUMENTS
    : EMPTY_CHANNEL_DOCUMENTS;
  const archivedChannelDocuments = selectedConversationChannelName
    ? indexes.archivedDocumentsByChannelName.get(selectedConversationChannelName) ?? EMPTY_ARCHIVED_CHANNEL_DOCUMENTS
    : EMPTY_ARCHIVED_CHANNEL_DOCUMENTS;
  const channelFiles = selectedConversationChannelName
    ? indexes.filesByChannelName.get(selectedConversationChannelName) ?? EMPTY_CHANNEL_FILES
    : EMPTY_CHANNEL_FILES;
  const channelDocumentRuns = selectedConversationChannelName
    ? indexes.runsByChannelName.get(selectedConversationChannelName) ?? EMPTY_DOCUMENT_RUNS
    : EMPTY_DOCUMENT_RUNS;
  const channelDocumentIdSet = useMemo(
    () => new Set(channelDocuments.map((document) => document.id)),
    [channelDocuments],
  );
  const channelDocumentConflicts = useMemo(
    () =>
      channelDocuments.flatMap((document) =>
        indexes.openConflictsByDocumentId.get(document.id) ?? EMPTY_DOCUMENT_CONFLICTS,
      ),
    [channelDocuments, indexes],
  );
  const selectedDocument = selectedDocumentId
    ? (() => {
        const document = indexes.documentById.get(selectedDocumentId) ?? null;
        return document?.channelName === selectedConversationChannelName && document.status === "active" ? document : null;
      })()
    : isCreatingDocument
      ? null
      : channelDocuments[0] ?? null;
  const selectedDocumentDraftSource = selectedDocument ? buildDocumentDraftSource(selectedDocument) : null;
  const selectedDocumentConflicts = selectedDocument
    ? indexes.openConflictsByDocumentId.get(selectedDocument.id) ?? EMPTY_DOCUMENT_CONFLICTS
    : EMPTY_DOCUMENT_CONFLICTS;
  const selectedDetailLoaded = selectedConversationChannelName
    ? indexes.loadedDetailChannelNames.has(selectedConversationChannelName)
    : true;
  const selectedDetailLoading = Boolean(
    selectedConversationChannelName && loadingDetailChannelName === selectedConversationChannelName,
  );
  const filteredChannelFiles = useMemo(() => {
    const query = fileSearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) {
      return channelFiles;
    }
    return channelFiles.filter((file) => {
      const haystack = [file.fileName, file.sourceSpeaker, file.sourceTime, file.mediaType]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return haystack.includes(query);
    });
  }, [channelFiles, fileSearch]);
  const filteredChannelDocuments = useMemo(() => {
    const query = documentSearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) {
      return channelDocuments;
    }
    return channelDocuments.filter((document) => {
      const haystack = [document.title, document.summary, document.updatedBy]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return haystack.includes(query);
    });
  }, [channelDocuments, documentSearch]);
  const hasPendingThreadMessages = useMemo(
    () => (selectedThread?.messages ?? []).some((message) => message.status === "pending"),
    [selectedThread],
  );
  const activeConversationTaskId = useMemo(
    () => (selectedThread?.messages ?? []).find(
      (message) => message.status === "pending" && Boolean(message.data?.source_task_queue_id),
    )?.data?.source_task_queue_id,
    [selectedThread],
  );
  const shouldPollChannelUpdates = useMemo(() => {
    if (isContactDirectoryContext || !selectedChannel || !selectedConversationChannelName) {
      return false;
    }

    const hasRunningDocumentWorkflow = channelDocumentRuns.some((run) => run.status === "pending" || run.status === "running");
    const hasProcessingAgentPresence = channelDocuments.some((document) =>
      document.activePresences.some((presence) => presence.actorType === "agent" && presence.status === "processing"),
    );

    return hasPendingThreadMessages || hasRunningDocumentWorkflow || hasProcessingAgentPresence;
  }, [channelDocumentRuns, channelDocuments, hasPendingThreadMessages, isContactDirectoryContext, selectedChannel, selectedConversationChannelName]);

  useChannelRealtimeRefresh({
    workspaceId: data.workspaceId,
    channelName: selectedConversationChannelName,
    enabled:
      !isContactDirectoryContext &&
      activeTab === "messages" &&
      Boolean(selectedConversationChannelName) &&
      !selectedChannelRequiresAccess,
    onInvalidation,
    onOpenMontageChange: () => setOpenMontageRefreshVersion((version) => version + 1),
    refresh: () => refreshChannelData({ allowWhileInputActive: true }),
  });

  useEffect(() => {
    setHasOpenMontageJobs(false);
  }, [selectedConversationChannelName]);

  useEffect(() => {
    if (selectedChannel?.kind === "direct" && !selectedConversationChannelName && activeTab !== "messages") {
      setActiveTab("messages");
      setDocumentsView("list");
    }
  }, [activeTab, selectedChannel?.kind, selectedConversationChannelName]);

  useEffect(() => {
    if (!selectedConversationChannelName || selectedChannelRequiresAccess || selectedDetailLoaded) {
      return;
    }

    const channelDetailCacheKey = buildChannelDetailCacheKey(selectedConversationChannelName);
    const cachedDetail = moduleCache?.get<ChannelDetailData>(channelDetailCacheKey);
    if (cachedDetail?.status === "ready" && cachedDetail.data && !cachedDetail.metadata.stale) {
      const cachedChannelDetail = cachedDetail.data;
      setDetailDataByChannelName((current) => {
        const next = new Map(current);
        for (const channelName of cachedChannelDetail.detailScope ?? [selectedConversationChannelName]) {
          next.set(channelName, cachedChannelDetail);
        }
        return next;
      });
      setDetailLoadError(null);
      return;
    }

    let cancelled = false;
    setLoadingDetailChannelName(selectedConversationChannelName);
    setDetailLoadError(null);

    const detailPromise = moduleCache
      ? moduleCache.load<ChannelDetailData>({
          cacheKey: channelDetailCacheKey,
          loader: () => getChannelDetailDataAction({
            channelName: selectedConversationChannelName,
            workspaceId: data.workspaceId,
          }),
          metadata: (detail) => buildImChannelDetailCacheMetadata(detail, selectedConversationChannelName),
          forbidden: (error) => error instanceof Error && /forbidden/i.test(error.message),
        })
      : getChannelDetailDataAction({
          channelName: selectedConversationChannelName,
          workspaceId: data.workspaceId,
        });

    detailPromise
      .then((detail) => {
        if (cancelled) {
          return;
        }
        setDetailDataByChannelName((current) => {
          const next = new Map(current);
          for (const channelName of detail.detailScope ?? [selectedConversationChannelName]) {
            next.set(channelName, detail);
          }
          return next;
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setDetailLoadError(error instanceof Error ? error.message : tx("加载失败", "Load failed"));
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setLoadingDetailChannelName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    data.workspaceId,
    buildChannelDetailCacheKey,
    moduleCache,
    selectedChannelRequiresAccess,
    selectedConversationChannelName,
    selectedDetailLoaded,
    tx,
  ]);

  useEffect(() => {
    if (isCreatingDocument) {
      return;
    }
    if (!selectedDocumentId || !channelDocumentIdSet.has(selectedDocumentId)) {
      setSelectedDocumentId(channelDocuments[0]?.id ?? null);
    }
  }, [channelDocumentIdSet, channelDocuments, isCreatingDocument, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocument) {
      if (!isCreatingDocument) {
        documentDraftSourceRef.current = null;
        setDraftTitle("");
        setDraftSummary("");
        setDraftContent("");
      }
      return;
    }
    if (documentDraftSourceRef.current === selectedDocumentDraftSource) {
      return;
    }
    documentDraftSourceRef.current = selectedDocumentDraftSource;
    setIsCreatingDocument(false);
    setDraftTitle(selectedDocument.title);
    setDraftSummary(selectedDocument.summary);
    setDraftContent(selectedDocument.contentMarkdown);
  }, [
    isCreatingDocument,
    selectedDocument?.contentMarkdown,
    selectedDocument?.currentVersionId,
    selectedDocument?.id,
    selectedDocument?.summary,
    selectedDocument?.title,
    selectedDocumentDraftSource,
  ]);

  useEffect(() => {
    if (!currentUserDisplayName.trim() || !selectedDocument?.id || isCreatingDocument) {
      return;
    }
    void touchChannelDocumentPresenceAction({
      documentId: selectedDocument.id,
      status: "viewing",
    });
  }, [currentUserDisplayName, isCreatingDocument, selectedDocument?.id]);

  useEffect(() => {
    if (!shouldPollChannelUpdates) {
      return;
    }

    // SSE reduces latency; pending-message polling guarantees convergence if an event is missed.
    const timer = window.setInterval(() => {
      refreshChannelData({ allowWhileInputActive: hasPendingThreadMessages });
    }, CHANNEL_REFRESH_POLL_MS);

    return () => window.clearInterval(timer);
  }, [hasPendingThreadMessages, refreshChannelData, shouldPollChannelUpdates]);
  const selectedComposerAgent = useMemo(() => {
    const employeeId = selectedChannel?.contactId
      ?? (selectedChannel?.employeeNames?.length === 1 ? selectedChannel.employeeNames[0] : undefined);
    const selected = employeeId
      ? data.composerAgents?.find((agent) =>
          agent.id.localeCompare(employeeId, "zh-CN", { sensitivity: "base" }) === 0
        )
      : undefined;
    if (!selected || !composerExecutionPolicyOverrides.has(selected.id)) {
      return selected;
    }
    return {
      ...selected,
      executionPolicy: composerExecutionPolicyOverrides.get(selected.id) ?? undefined,
    };
  }, [composerExecutionPolicyOverrides, data.composerAgents, selectedChannel]);
  const composerRuntime: ConversationComposerRuntime | undefined =
    selectedComposerAgent?.provider === "claude" || selectedComposerAgent?.provider === "codex"
      ? {
          employeeId: selectedComposerAgent.id,
          employeeLabel: selectedComposerAgent.label,
          provider: selectedComposerAgent.provider,
          executionPolicy: selectedComposerAgent.executionPolicy,
          requiresMentionForCommands: selectedChannel?.kind !== "direct",
        }
      : undefined;
  const mentionCandidates: ConversationMentionCandidate[] = useMemo(() => {
    if (!selectedChannel) {
      return [];
    }

    const members = selectedChannel.kind === "direct"
      ? []
      : (selectedConversationChannelName
          ? indexes.mentionCandidatesByChannelName.get(selectedConversationChannelName) ?? EMPTY_MENTION_CANDIDATES
          : EMPTY_MENTION_CANDIDATES)
        .map((candidate) => ({
          id: `member:${candidate.id}`,
          label: candidate.label,
          subtitle: candidate.subtitle,
          inChannel: true,
          kind: candidate.kind ?? "agent",
        } satisfies ConversationMentionCandidate));
    const files = (selectedConversationChannelName
      ? indexes.filesByChannelName.get(selectedConversationChannelName) ?? EMPTY_CHANNEL_FILES
      : EMPTY_CHANNEL_FILES)
      .map((file) => ({
        id: `file:${file.id}`,
        sourceId: file.id,
        label: file.fileName,
        subtitle: file.previewText?.trim() || file.mediaType,
        inChannel: true,
        kind: "file" as const,
      }));
    const skills = (selectedComposerAgent?.skills ?? []).map((skill) => ({
      id: `skill:${skill.id}`,
      sourceId: skill.id,
      label: skill.name,
      subtitle: skill.description,
      inChannel: true,
      kind: "skill" as const,
    }));
    const kindOrder: Record<NonNullable<ConversationMentionCandidate["kind"]>, number> = {
      agent: 0,
      human: 1,
      file: 2,
      skill: 3,
    };
    return [...members, ...files, ...skills].sort((left, right) =>
      kindOrder[left.kind ?? "agent"] - kindOrder[right.kind ?? "agent"] ||
      left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" })
    );
  }, [indexes, selectedChannel, selectedComposerAgent, selectedConversationChannelName]);

  const addableChannelMemberCandidates = useMemo(() => {
    if (!selectedChannel || selectedChannel.kind === "direct") {
      return [];
    }
    const existingHumanMemberNames = new Set((selectedChannel.humanMemberNames ?? []).map(normalizeMemberKey));
    const existingAgentNames = new Set((selectedChannel.employeeNames ?? []).map(normalizeMemberKey));
    return (data.channelMemberCandidates ?? [])
      .filter((candidate) =>
        candidate.kind === "agent"
          ? !existingAgentNames.has(normalizeMemberKey(candidate.id))
          : !existingHumanMemberNames.has(normalizeMemberKey(candidate.label))
      )
      .sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" }));
  }, [data.channelMemberCandidates, selectedChannel]);

  const items: ConversationListItem[] = useMemo(
    () =>
      visibleChannels.map((channel) => {
        const presentationChannel = applyLiveFeishuMemberSnapshot(
          channel,
          channel.feishu ? feishuMemberSnapshotByChannelName.get(channel.name) ?? undefined : undefined,
        );
        return {
          id: channel.id,
          title: presentationChannel?.displayName ?? channel.displayName ?? channel.name,
          subtitle:
            channel.kind === "direct"
              ? channel.displaySubtitle ?? tx("私聊", "Direct")
              : translateMemberLabel(presentationChannel?.memberLabel ?? channel.memberLabel, tx),
          meta: isContactDirectoryContext
            ? channel.channelName
              ? tx("已建立私聊", "Direct message available")
              : tx("尚未开始私聊", "No direct message yet")
            : translateChannelAccessPreview(channel.accessState, tx)
              ?? translateChannelPreview(
                resolveSelectedChannelName(channel) ?? channel.id,
                indexes.threadByChannelName,
                tx,
              )
              ?? translateChannelListPreview(channel.lastMessage, tx)
              ?? tx("还没有消息", "No messages yet"),
          avatar: channel.avatarLabel ?? "#",
          avatarId: channel.humanContactUserId ?? channel.contactId ?? channel.channelName ?? channel.id,
          avatarName: presentationChannel?.displayName ?? channel.displayName ?? channel.name,
          avatarVariant: channel.directParticipantKind === "human" ? "human" : channel.kind === "direct" ? "agent" : "channel",
          dateLabel: formatCompactTimestamp(channel.updatedAt, { emptyFallback: "" }),
          unread: channel.unread,
        };
      }),
    [feishuMemberSnapshotByChannelName, indexes.threadByChannelName, isContactDirectoryContext, tx, visibleChannels],
  );

  const messages: ConversationThreadMessage[] = useMemo(
    () => {
      const threadMessages = selectedThread?.messages ?? [];
      const taskExecutions = selectedThread?.taskExecutions;

      // Fold the flat process messages of one task into a single timeline carrier:
      // the first process message of each task (whose structured stream is available)
      // carries the execution timeline, the rest are removed from the list.
      const carrierIdByTaskId = new Map<string, string>();
      const foldedMessageIds = new Set<string>();
      if (taskExecutions) {
        for (const [index, message] of threadMessages.entries()) {
          if (message.kind !== "process") {
            continue;
          }
          const taskId = message.data?.source_task_queue_id;
          if (!taskId || !taskExecutions[taskId]?.length) {
            continue;
          }
          const messageId = message.id || `${message.speaker}-${message.time}-${index}`;
          if (carrierIdByTaskId.has(taskId)) {
            foldedMessageIds.add(messageId);
          } else {
            carrierIdByTaskId.set(taskId, messageId);
          }
        }
      }

      const pendingTaskIds = new Set(
        threadMessages
          .filter((message) => message.status === "pending" && Boolean(message.data?.source_task_queue_id))
          .map((message) => message.data?.source_task_queue_id as string),
      );

      // Keep the final agent reply in the same visual unit as its execution
      // trace. This avoids a second bubble repeating the last narration row.
      const executionReplyByTaskId = new Map<string, (typeof threadMessages)[number]>();
      for (const message of threadMessages) {
        const taskId = message.data?.source_task_queue_id;
        if (
          message.role === "agent" &&
          message.kind !== "process" &&
          taskId &&
          carrierIdByTaskId.has(taskId)
        ) {
          executionReplyByTaskId.set(taskId, message);
        }
      }

      return threadMessages.flatMap((message, index) => {
        const id = message.id || `${message.speaker}-${message.time}-${index}`;
        if (foldedMessageIds.has(id)) {
          return [];
        }
        const taskId = message.data?.source_task_queue_id;
        if (
          message.role === "agent" &&
          message.kind !== "process" &&
          taskId &&
          carrierIdByTaskId.has(taskId)
        ) {
          return [];
        }
        const executionReply = taskId && carrierIdByTaskId.get(taskId) === id
          ? executionReplyByTaskId.get(taskId)
          : undefined;
        if (executionReply && executionReply.id === id) {
          return [];
        }
        const executionRows = taskId && carrierIdByTaskId.get(taskId) === id
          ? taskExecutions?.[taskId]
          : undefined;
        const executionReplyMessage = executionReply
          ? {
              id: executionReply.id,
              speaker: executionReply.speaker,
              role: executionReply.role,
              content: executionReply.summary,
              code: executionReply.code,
              data: executionReply.data,
              executionDetail: executionReply.data?.execution_detail,
              timestamp: formatCompactTimestamp(executionReply.time, { emptyFallback: executionReply.time }),
              status: executionReply.status ?? "completed",
              attachments: executionReply.attachments,
              mentions: executionReply.mentions,
              acknowledgements: executionReply.acknowledgements,
              kind: executionReply.kind,
              processType: executionReply.processType,
              tool: executionReply.tool,
              pinned: executionReply.pinned,
              pinnedAt: executionReply.pinnedAt,
              replyToMessageId: executionReply.replyToMessageId,
            }
          : undefined;
        return [{
          id,
          speaker: message.speaker,
          role: message.role,
          content: message.summary,
          code: message.code,
          data: message.data,
          executionDetail: message.data?.execution_detail,
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
          ...(executionReplyMessage ? { executionReply: executionReplyMessage } : {}),
          ...(executionRows
            ? {
                execution: buildExecutionTimeline(
                  executionRows,
                  {
                    thinking: tx("思考过程", "Thinking"),
                    error: (value) => translateRuntimeFailureSummary(value, tx),
                  },
                  { taskRunning: Boolean(taskId && pendingTaskIds.has(taskId)) },
                ).filter((item) => {
                  const replyContent = executionReplyMessage?.content.replace(/\s+/g, " ").trim();
                  return !(item.kind === "narration" && replyContent && item.title.replace(/\s+/g, " ").trim() === replyContent);
                }),
                executionRunning: Boolean(taskId && pendingTaskIds.has(taskId)),
              }
            : {}),
        }];
      });
    },
    [selectedThread, tx],
  );
  const emptyThreadTitle = selectedChannel
    ? tx("还没有消息", "No messages yet")
    : tx("未选择会话", "No conversation selected");
  const emptyThreadBody = selectedChannel
    ? tx("发一条消息开始对话。", "Send a message to start the conversation.")
    : tx("先从左侧选择一个会话。", "Select a conversation from the list first.");

  useEffect(() => {
    setShowContactRemarkEditor(false);
  }, [selectedChannel?.id]);

  function switchChannelTab(nextTab: ChannelWorkspaceTab): void {
    if (!selectedChannel) {
      return;
    }
    if (!selectedConversationChannelName && nextTab !== "messages") {
      return;
    }
    markInteraction("tab-switch");
    setActiveTab(nextTab);
    setDocumentsView(nextTab === "documents" && routeState.documentId ? "workspace" : "list");
    setShowHeaderMenu(false);
    setShowCreateMenu(false);
    replaceChannelRoute(selectedChannel.id, {
      tab: nextTab,
      documentId: nextTab === "documents" && documentsView === "workspace" ? selectedDocumentId : null,
    });
    measureInteraction("tab-switch");
  }

  function openSelectedDigitalConversation(): void {
    if (!selectedChannel) {
      return;
    }
    const nextSearch = new URLSearchParams({
      view: "direct",
      focus: buildChannelFocusValue(selectedChannel, selectedChannel.id),
    });
    navigateToWorkspaceModule(`/im?${nextSearch.toString()}`);
  }

  function openSelectedDigitalEmployee(): void {
    if (!selectedChannel?.contactId) {
      return;
    }
    const agentReference = selectedChannel.agentEmployeeId ?? selectedChannel.contactId;
    navigateToWorkspaceModule(`/agents?mode=agent&focus=${encodeURIComponent(`agent:${agentReference}`)}`);
  }

  async function uploadChannelFiles(files: FileList | null): Promise<void> {
    if (!selectedConversationChannelName || !files || files.length === 0) {
      return;
    }

    const formData = new FormData();
    formData.set("channelName", selectedConversationChannelName);
    formData.set("content", tx("请查看我发送的文件。", "Please review the file I sent."));
    Array.from(files).forEach((file) => formData.append("attachments", file));
    await sendChannelMessageAction(formData);
  }

  function deleteChannelFile(file: ChannelsPageData["channelFiles"][number]): void {
    if (!selectedConversationChannelName || !file.canDelete) {
      return;
    }
    const confirmed = window.confirm(
      file.retainedBecauseReferenced
        ? tx(
            `「${file.fileName}」已被知识库或群文档引用。删除只会从群文件列表移除，底层文件会保留。继续？`,
            `"${file.fileName}" is referenced by knowledge or cloud docs. Deleting only removes it from the group file list; the stored file is retained. Continue?`,
          )
        : tx(
            `确定删除群文件「${file.fileName}」？`,
            `Delete group file "${file.fileName}"?`,
          ),
    );
    if (!confirmed) {
      return;
    }
    startTransition(async () => {
      try {
        setFileFeedback(null);
        setDocumentFeedback(null);
        await deleteChannelAttachmentAction({
          channelName: selectedConversationChannelName,
          attachmentId: file.id,
        });
        setFileFeedback(
          file.retainedBecauseReferenced
            ? tx("文件已从群文件列表移除，底层文件因引用关系保留。", "File removed from group files; the stored file was retained because it is referenced.")
            : tx("文件已删除。", "File deleted."),
        );
        refreshChannelModule(selectedConversationChannelName);
      } catch (error) {
        const message = error instanceof Error ? error.message : tx("删除失败", "Delete failed");
        setFileFeedback(message);
        setDocumentFeedback(message);
      }
    });
  }

  function deleteChannelDocument(document: ChannelsPageData["documents"][number]): void {
    if (document.currentUserRole !== "owner") {
      return;
    }
    const confirmed = window.confirm(
      tx(
        `确定删除云文档「${document.title}」？删除后可在已删除文档中恢复。`,
        `Delete cloud document "${document.title}"? You can restore it from deleted documents.`,
      ),
    );
    if (!confirmed) {
      return;
    }
    startTransition(async () => {
      try {
        setDocumentFeedback(null);
        setRecoverableDraft(null);
        await archiveChannelDocumentAction(document.id);
        if (selectedDocumentId === document.id) {
          setSelectedDocumentId(null);
        }
        setDocumentsView("list");
        if (selectedChannel) {
          replaceChannelRoute(selectedChannel.id, {
            tab: "documents",
            documentId: null,
          });
        }
        refreshChannelModule(selectedConversationChannelName);
      } catch (error) {
        setDocumentFeedback(error instanceof Error ? error.message : tx("删除失败", "Delete failed"));
      }
    });
  }

  function openFreshDocumentWorkspace(initialTitle?: string, mode: ChannelDocumentCreateMode = "markdown"): void {
    if (!selectedChannel || !selectedConversationChannelName) {
      return;
    }

    documentDraftSourceRef.current = null;
    setActiveTab("documents");
    setDocumentsView("workspace");
    setIsCreatingDocument(true);
    setDocumentCreateMode(mode);
    setSelectedDocumentId(null);
    setDocumentFeedback(null);
    setRecoverableDraft(null);
    setDraftTitle(initialTitle ?? "");
    setDraftSummary("");
    setDraftContent(buildInitialDocumentDraftContent(mode, tx));
    setShowCreateMenu(false);
    replaceChannelRoute(selectedChannel.id, {
      tab: "documents",
      documentId: null,
    });
  }

  const documentWorkbench =
    selectedChannel && selectedConversationChannelName ? (
      <div className="channel-workspace-panel channel-workspace-panel--documents">
        <div className="channel-workspace-panel__toolbar">
          <div>
            <h3>
              {isCreatingDocument
                ? documentCreateMode === "nativeSheet"
                  ? tx("新建表格", "New sheet")
                  : documentCreateMode === "nativeDeck"
                    ? tx("新建 Deck", "New deck")
                    : tx("新建云文档", "New cloud doc")
                : tx("云文档工作台", "Cloud docs workspace")}
            </h3>
          </div>
          <div className="detail-actions">
            <button
              className="action-button"
              disabled={isPending}
              onClick={() => {
                setDocumentsView("list");
                replaceChannelRoute(selectedChannel.id, {
                  tab: "documents",
                  documentId: null,
                });
              }}
              type="button"
            >
              {tx("返回列表", "Back to list")}
            </button>
          </div>
        </div>

        <ChannelDocumentsPanel
          archivedDocuments={archivedChannelDocuments}
          documents={channelDocuments}
          selectedDocument={selectedDocument}
          selectedDocumentConflicts={selectedDocumentConflicts}
          draftContent={draftContent}
          currentVersionId={selectedDocument?.currentVersionId}
          createMode={isCreatingDocument ? documentCreateMode : "markdown"}
          draftSummary={draftSummary}
          draftTitle={draftTitle}
          feedback={documentFeedback}
          hasRecoverableDraft={recoverableDraft?.documentId === selectedDocument?.id}
          runs={channelDocumentRuns}
          conflicts={channelDocumentConflicts}
          channelFiles={channelFiles}
          onDeleteAttachment={deleteChannelFile}
          onArchive={() => {
            if (!selectedDocument) {
              return;
            }
            deleteChannelDocument(selectedDocument);
          }}
          onRestoreArchived={(documentId) => {
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                const result = await restoreChannelDocumentAction(documentId);
                setSelectedDocumentId(result.documentId);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("恢复失败", "Restore failed"));
              }
            });
          }}
          onCreateNew={() => openFreshDocumentWorkspace()}
          onDraftContentChange={setDraftContent}
          onDraftSummaryChange={setDraftSummary}
          onDraftTitleChange={setDraftTitle}
          onBeginEditing={() => {
            if (!currentUserDisplayName.trim() || !selectedDocument?.id) {
              return;
            }
            void touchChannelDocumentPresenceAction({
              documentId: selectedDocument.id,
              status: "editing",
            });
          }}
          onRestoreRecoverableDraft={() => {
            if (!recoverableDraft || recoverableDraft.documentId !== selectedDocument?.id) {
              return;
            }
            setDraftTitle(recoverableDraft.title);
            setDraftSummary(recoverableDraft.summary);
            setDraftContent(recoverableDraft.content);
            setRecoverableDraft(null);
            setDocumentFeedback(
              tx(
                "已恢复你刚才未保存的草稿。保存前请先和最新版本手动合并。",
                "Your previous draft was restored. Merge it with the latest version before saving again.",
              ),
            );
          }}
          onDismissRecoverableDraft={() => {
            setRecoverableDraft(null);
          }}
          onSave={() => {
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                const result = await saveChannelDocumentAction({
                  documentId: selectedDocument?.id,
                  baseVersionId: selectedDocument?.currentVersionId,
                  channelName: selectedConversationChannelName,
                  title: draftTitle,
                  contentMarkdown: draftContent,
                  summary: draftSummary,
                  kind: resolveDocumentKindForCreateMode(documentCreateMode),
                });
                setIsCreatingDocument(false);
                setDocumentCreateMode("markdown");
                setRecoverableDraft(null);
                setSelectedDocumentId(result.documentId);
                replaceChannelRoute(selectedChannel.id, {
                  tab: "documents",
                  documentId: result.documentId,
                });
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                const message = error instanceof Error ? error.message : tx("保存失败", "Save failed");
                if (selectedDocument?.id && isStaleChannelDocumentSaveError(message)) {
                  setRecoverableDraft({
                    documentId: selectedDocument.id,
                    title: draftTitle,
                    summary: draftSummary,
                    content: draftContent,
                  });
                  setDocumentFeedback(
                    tx(
                      "这份文档在你编辑期间已被别人更新。编辑器已经切到最新版本；如需继续，请把你的草稿合并进去后再保存。",
                      "This document was updated by someone else while you were editing. The editor has been refreshed to the latest version; merge your draft back in before saving again.",
                    ),
                  );
                  refreshChannelModule(selectedConversationChannelName);
                  return;
                }
                setDocumentFeedback(message);
              }
            });
          }}
          onSelectDocument={(documentId) => {
            setIsCreatingDocument(false);
            setDocumentCreateMode("markdown");
            setDocumentFeedback(null);
            setRecoverableDraft(null);
            setSelectedDocumentId(documentId);
            replaceChannelRoute(selectedChannel.id, {
              tab: "documents",
              documentId,
            });
          }}
          onRollback={(versionId) => {
            if (!selectedDocument) {
              return;
            }
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                setRecoverableDraft(null);
                const result = await rollbackChannelDocumentVersionAction({
                  documentId: selectedDocument.id,
                  versionId,
                });
                setSelectedDocumentId(result.documentId);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("回滚失败", "Rollback failed"));
              }
            });
          }}
          onResolveConflict={(conflictId) => {
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                await resolveChannelDocumentConflictAction(conflictId);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("处理冲突失败", "Resolve conflict failed"));
              }
            });
          }}
          onLoadConflictDraft={(conflictId) => {
            const conflict = indexes.conflictById.get(conflictId);
            if (!conflict?.mergePreview) {
              return;
            }
            const document = indexes.documentById.get(conflict.documentId);
            documentDraftSourceRef.current = document ? buildDocumentDraftSource(document) : null;
            setIsCreatingDocument(false);
            setSelectedDocumentId(conflict.documentId);
            setRecoverableDraft(null);
            setDraftTitle(conflict.mergePreview.suggestedDraftTitle ?? document?.title ?? "");
            setDraftSummary(conflict.mergePreview.suggestedDraftSummary ?? document?.summary ?? "");
            setDraftContent(conflict.mergePreview.suggestedDraftContentMarkdown);
            setDocumentFeedback(
              tx(
                "已将冲突改动载入草稿。请参考下方“当前内容 / 冲突改动”对照后手动合并，再决定是否保存。",
                "The conflicted change was loaded into the draft. Compare the current and incoming content below, then merge manually before saving.",
              ),
            );
            replaceChannelRoute(selectedChannel.id, {
              tab: "documents",
              documentId: conflict.documentId,
            });
          }}
          onRetryConflict={(conflictId) => {
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                const result = await retryChannelDocumentConflictAction(conflictId);
                setSelectedDocumentId(result.documentId);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("重新应用失败", "Retry failed"));
              }
            });
          }}
          onUpdateCollaboratorRole={(input) => {
            if (!selectedDocument?.id) {
              return;
            }
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                await updateChannelDocumentAccessRoleAction({
                  documentId: selectedDocument.id,
                  actorId: input.actorId,
                  actorType: input.actorType,
                  role: input.role,
                });
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("更新权限失败", "Permission update failed"));
              }
            });
          }}
          onAddCollaborator={(input) => {
            if (!selectedDocument?.id) {
              return;
            }
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                await addChannelDocumentCollaboratorAction({
                  documentId: selectedDocument.id,
                  actorId: input.actorId,
                  actorType: input.actorType,
                  role: input.role,
                });
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("添加协作者失败", "Add collaborator failed"));
              }
            });
          }}
          onRemoveCollaborator={(input) => {
            if (!selectedDocument?.id) {
              return;
            }
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                await removeChannelDocumentCollaboratorAction({
                  documentId: selectedDocument.id,
                  actorId: input.actorId,
                  actorType: input.actorType,
                });
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("移除协作者失败", "Remove collaborator failed"));
              }
            });
          }}
          onExport={() => {
            if (!selectedDocument) {
              return;
            }
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                setRecoverableDraft(null);
                await exportChannelDocumentAttachmentAction(selectedDocument.id);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("导出失败", "Export failed"));
              }
            });
          }}
          onImportAttachment={(attachmentId, fileName) => {
            startTransition(async () => {
              try {
                setDocumentFeedback(null);
                setRecoverableDraft(null);
                const result = await createChannelDocumentFromAttachmentAction({
                  channelName: selectedConversationChannelName,
                  attachmentId,
                  title: fileName.replace(/\.md$/i, ""),
                });
                setSelectedDocumentId(result.documentId);
                setDocumentsView("workspace");
                replaceChannelRoute(selectedChannel.id, {
                  tab: "documents",
                  documentId: result.documentId,
                });
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setDocumentFeedback(error instanceof Error ? error.message : tx("导入失败", "Import failed"));
              }
            });
          }}
          onViewDocumentInKnowledge={(documentId) => {
            navigateToWorkspaceModule(`/knowledge?view=documents&document=${encodeURIComponent(`channelDocument:${documentId}`)}`);
          }}
          onViewAttachmentInKnowledge={(attachmentId) => {
            navigateToWorkspaceModule(`/knowledge?view=documents&document=${encodeURIComponent(`attachment:${attachmentId}`)}`);
          }}
          pending={isPending}
          selectedDocumentId={selectedDocument?.id ?? null}
          tx={tx}
        />
      </div>
    ) : null;

  return (
    <>
      {showCreateChannel ? (
        <CreateChannelModal
          candidates={(data.channelMemberCandidates ?? []).filter(
            (candidate) => candidate.id !== currentUserDisplayName && candidate.label !== currentUserDisplayName,
          )}
          pending={isPending}
          onClose={() => setShowCreateChannel(false)}
          onSubmit={(input) => {
            startTransition(async () => {
              await createChannelAction(input);
              setShowCreateChannel(false);
              refreshChannelModule();
            });
          }}
        />
      ) : null}

      {showRename && selectedChannel && selectedChannelCanRename ? (
        <RenameChannelModal
          channelName={selectedChannel.name}
          languageLabel={(zh, en) => tx(zh, en)}
          pending={isPending}
          onCancel={() => setShowRename(false)}
          onConfirm={(nextName) => {
            startTransition(async () => {
              await renameChannelAction({
                channelName: selectedChannel.name,
                nextName,
              });
              setShowRename(false);
              refreshChannelModule(selectedConversationChannelName);
            });
          }}
        />
      ) : null}

      {showAddMembers && selectedChannel && selectedConversationChannelName ? (
        <AddChannelMembersModal
          candidates={addableChannelMemberCandidates}
          channelName={selectedChannel.displayName ?? selectedChannel.name}
          feedback={addMembersFeedback}
          pending={isPending}
          onCancel={() => {
            setShowAddMembers(false);
            setAddMembersFeedback(null);
          }}
          onConfirm={({ userIds, agentIds }) => {
            startTransition(async () => {
              try {
                await addWorkspaceMembersToChannelAction({
                  channelName: selectedConversationChannelName,
                  workspaceId: data.workspaceId,
                  userIds,
                  agentIds,
                });
                setShowAddMembers(false);
                setAddMembersFeedback(null);
                refreshChannelModule(selectedConversationChannelName);
              } catch (error) {
                setAddMembersFeedback(error instanceof Error ? error.message : tx("添加失败", "Add failed"));
              }
            });
          }}
        />
      ) : null}

      {showModelCommandDialog && selectedChannel && composerRuntime ? (
        <ChatModelCommandDialog
          channelName={selectedChannel.kind === "direct" ? undefined : selectedConversationChannelName ?? undefined}
          contactId={selectedChannel.kind === "direct" ? selectedChannel.contactId : undefined}
          content={selectedChannel.kind === "direct" ? undefined : `@${composerRuntime.employeeId}`}
          displayName={selectedChannel.displayName ?? composerRuntime.employeeLabel}
          onChanged={() => refreshChannelModule(selectedConversationChannelName)}
          onClose={() => setShowModelCommandDialog(false)}
        />
      ) : null}

      <ConversationShell
        isAgentRunning={Boolean(activeConversationTaskId)}
        onStopActiveTask={activeConversationTaskId ? async () => {
          await stopChannelTaskAction(activeConversationTaskId);
          refreshChannelModule(selectedConversationChannelName);
        } : undefined}
        emptyListBody={
          isContactDirectoryContext
            ? tx("创建数字员工后，可在这里查看资料并发起私聊。", "Create a digital employee to view its profile and start a direct message here.")
            : tx("当前还没有任何会话。", "There are no conversations yet.")
        }
        emptyListTitle={isContactDirectoryContext ? tx("暂无数字员工", "No digital employees") : tx("会话为空", "No conversations")}
        emptyThreadBody={emptyThreadBody}
        emptyThreadTitle={emptyThreadTitle}
        threadHasSupplementaryContent={hasOpenMontageJobs}
        threadAfterMessages={
          !isContactDirectoryContext && activeTab === "messages" && selectedConversationChannelName && !selectedChannelRequiresAccess ? (
            <OpenMontageChannelJobs
              channelName={selectedConversationChannelName}
              onPresenceChange={setHasOpenMontageJobs}
              refreshVersion={openMontageRefreshVersion}
              workspaceId={data.workspaceId}
            />
          ) : undefined
        }
        customThreadHeader={
          selectedChannel
            ? ({ backButton }) => isContactDirectoryContext ? (
                <DigitalEmployeeDirectoryHeader
                  backButton={backButton}
                  channel={selectedChannel}
                  onManage={openSelectedDigitalEmployee}
                  onMessage={openSelectedDigitalConversation}
                  tx={tx}
                />
              ) : (
                <ChannelWorkspaceHeader
                  activeTab={activeTab}
                  backButton={backButton}
                  contentTabsEnabled={Boolean(selectedConversationChannelName)}
                  memberCount={selectedChannelWithLiveFeishuMembers?.memberCount ?? estimateChannelMemberCount(selectedChannel.memberLabel)}
                  liveFeishuMembers={selectedChannelWithLiveFeishuMembers?.feishu?.liveMembers}
                  onCreateAnnouncement={() => {
                    setShowHeaderMenu(false);
                    openFreshDocumentWorkspace(tx("群公告", "Announcement"));
                  }}
                  onCreateLabelPage={() => {
                    setShowHeaderMenu(false);
                    openFreshDocumentWorkspace(tx("标签页", "Label page"));
                  }}
                  onCreateDocument={() => openFreshDocumentWorkspace()}
                  onCreateNativeDeck={() => openFreshDocumentWorkspace("", "nativeDeck")}
                  onCreateNativeSheet={() => openFreshDocumentWorkspace("", "nativeSheet")}
                  onDeleteChannel={() => {
                    setShowHeaderMenu(false);
                    startTransition(async () => {
                      await deleteChannelAction(selectedChannel.name);
                      setSelectedChannelId(null);
                      replaceWorkspaceModule("/im");
                      refreshChannelModule(selectedConversationChannelName);
                    });
                  }}
                  onOpenCalendar={() => navigateToWorkspaceModule("/calendar")}
                  onOpenAddMembers={() => {
                    setShowHeaderMenu(false);
                    setAddMembersFeedback(null);
                    setShowAddMembers(true);
                  }}
                  onOpenTaskBoard={() => {
                    setShowHeaderMenu(false);
                    navigateToWorkspaceModule("/task/board");
                  }}
                  onOpenCreateMenu={() => {
                    setShowHeaderMenu(false);
                    setShowCreateMenu((current) => !current);
                  }}
                  onOpenRename={() => {
                    setShowHeaderMenu(false);
                    setShowRename(true);
                  }}
                  onOpenContactRemark={() => setShowContactRemarkEditor(true)}
                  onUploadFiles={() => {
                    setShowCreateMenu(false);
                    fileUploadInputRef.current?.click();
                  }}
                  onSearchAction={() => {
                    if (activeTab === "messages") {
                      switchChannelTab("files");
                      window.requestAnimationFrame(() => fileSearchInputRef.current?.focus());
                      return;
                    }
                    if (activeTab === "files") {
                      fileSearchInputRef.current?.focus();
                      return;
                    }
                    if (activeTab === "documents") {
                      documentSearchInputRef.current?.focus();
                    }
                  }}
                  onShowHeaderMenu={() => {
                    setShowCreateMenu(false);
                    setShowHeaderMenu((current) => !current);
                  }}
                  onSwitchTab={switchChannelTab}
                  pending={isPending}
                  selectedChannel={selectedChannelWithLiveFeishuMembers ?? selectedChannel}
                  showCreateMenu={showCreateMenu}
                  showHeaderMenu={showHeaderMenu}
                  createMenuRef={createMenuRef}
                  headerMenuRef={headerMenuRef}
                  tx={tx}
                />
              )
            : undefined
        }
        items={items}
        listActions={
          isContactDirectoryContext ? (
            <CommunicationListActions
              action={{
                label: tx("新建数字员工", "New digital employee"),
                onClick: () => navigateToWorkspaceModule("/agents?mode=agent&create=agent"),
              }}
              activeTab="digital"
              ariaLabel={tx("联系人类型", "Contact type")}
              tabs={[
                {
                  id: "people",
                  label: tx("真人", "People"),
                  onSelect: () => navigateToWorkspaceModule("/contacts"),
                },
                {
                  id: "digital",
                  label: tx("数字员工", "Digital employees"),
                  onSelect: () => {},
                },
              ]}
            />
          ) : (
            <CommunicationListActions
              action={{
                label: tx("创建群组", "Create group"),
                onClick: () => setShowCreateChannel(true),
              }}
              activeTab={conversationView === "direct" ? "digital" : "conversations"}
              ariaLabel={tx("消息类型", "Message type")}
              tabs={[
                {
                  id: "conversations",
                  label: tx("会话", "Conversations"),
                  onSelect: () => replaceWorkspaceModule("/im"),
                },
                {
                  id: "digital",
                  label: tx("数字联系人", "Digital contacts"),
                  onSelect: () => replaceWorkspaceModule("/im?view=direct"),
                },
              ]}
            />
          )
        }
        listCount={items.length}
        listKicker=""
        listTitle={isContactDirectoryContext ? tx("联系人", "Contacts") : tx("消息", "Messages")}
        mentionCandidates={mentionCandidates}
        messages={messages}
        onSelectItem={(channelId) => {
          markInteraction("conversation-switch");
          setSelectedChannelId(channelId);
          if (activeTab === "documents") {
            setDocumentsView("list");
          }
          replaceChannelRoute(channelId, {
            tab: activeTab,
            documentId: null,
          });
          measureInteraction("conversation-switch");
        }}
        composerRuntime={composerRuntime}
        onOpenModelSelector={composerRuntime ? () => setShowModelCommandDialog(true) : undefined}
        onUpdateExecutionPolicy={async (employeeId, executionPolicy: EmployeeExecutionPolicy | undefined) => {
          let updateSucceeded = false;
          await runToastAction({
            action: () => updateWorkspaceAgentExecutionPolicyAction({
              employeeName: employeeId,
              executionPolicy,
            }),
            onSuccess: async (_data, result) => {
              if (result.invalidation) {
                onInvalidation?.(result.invalidation);
              }
              setComposerExecutionPolicyOverrides((current) => {
                const next = new Map(current);
                next.set(employeeId, executionPolicy ?? null);
                return next;
              });
              updateSucceeded = true;
            },
            pushToast,
            tx,
          });
          if (!updateSucceeded) {
            throw new Error(tx("执行权限未保存，请重试。", "Execution permissions were not saved. Please try again."));
          }
        }}
        onSubmit={async ({ content, files, replyToMessageId, referenceAttachmentIds, referenceSkillIds }) => {
          if (!selectedChannel) {
            return;
          }
          const formData = new FormData();
          formData.set("content", content);
          files.forEach((file) => formData.append("attachments", file));
          referenceAttachmentIds?.forEach((attachmentId) => formData.append("attachmentReferences", attachmentId));
          referenceSkillIds?.forEach((skillId) => formData.append("skillReferences", skillId));
          if (referenceAttachmentIds?.length && selectedConversationChannelName) {
            formData.set("referenceChannelName", selectedConversationChannelName);
          }

          if (selectedChannel.kind === "direct") {
            if (!selectedChannel.contactId) {
              return;
            }

            formData.set("contactId", selectedChannel.contactId);
            await sendContactMessageAction(formData);
            refreshChannelModule(selectedConversationChannelName);
            return;
          }

          if (!selectedConversationChannelName) {
            return;
          }

          formData.set("channelName", selectedConversationChannelName);
          if (replyToMessageId) {
            formData.set("replyToMessageId", replyToMessageId);
          }
          await sendChannelMessageAction(formData);
          refreshChannelModule(selectedConversationChannelName);
        }}
        onPinMessage={(messageId) => {
          startTransition(async () => {
            try {
              await pinMessageAction(messageId);
            } catch (error) {
              console.error("[pin]", error);
            }
            refreshChannelModule(selectedConversationChannelName);
          });
        }}
        onUnpinMessage={(messageId) => {
          startTransition(async () => {
            try {
              await unpinMessageAction(messageId);
            } catch (error) {
              console.error("[unpin]", error);
            }
            refreshChannelModule(selectedConversationChannelName);
          });
        }}
        onAcknowledgeMessage={(messageId) => {
          startTransition(async () => {
            try {
              await acknowledgeMessageAction(messageId);
            } catch (error) {
              console.error("[acknowledge]", error);
            }
            refreshChannelModule(selectedConversationChannelName);
          });
        }}
        onReviewApproval={async (approvalId, decision) => {
          let reviewSucceeded = false;
          await runToastAction({
            action: () => reviewInlineApprovalAction(approvalId, decision),
            onSuccess: async (_data, result) => {
              if (result.invalidation) {
                onInvalidation?.(result.invalidation);
              }
              refreshChannelModule(selectedConversationChannelName);
              reviewSucceeded = true;
            },
            pushToast,
            tx,
          });
          if (!reviewSucceeded) {
            throw new Error(tx("审批未完成，请重试。", "Approval was not completed. Please try again."));
          }
        }}
        placeholder={
          selectedChannel
            ? tx(`发送到 ${selectedChannel.displayName ?? selectedChannel.name}`, `Send to ${selectedChannel.displayName ?? selectedChannel.name}`)
            : tx("发送消息", "Send a message")
        }
        shellClassName={
          isContactDirectoryContext
            ? "contacts-shell--directory contacts-shell--digital"
            : conversationView === "direct"
              ? "contacts-shell--chatting contacts-shell--digital"
              : "contacts-shell--chatting"
        }
        currentUserDisplayName={currentUserDisplayName}
        draftStorageKey={onDataChanged ? `${data.workspaceId}:im:composer` : undefined}
        scrollAnchorStorageKey={onDataChanged ? `${data.workspaceId}:im:scroll-anchors` : undefined}
        onDataChanged={onDataChanged}
        selectedHeader={
          selectedChannel
            ? {
                title: selectedChannelWithLiveFeishuMembers?.displayName ?? selectedChannel.displayName ?? selectedChannel.name,
                subtitle:
                  selectedChannel.kind === "direct"
                    ? selectedChannel.displaySubtitle ?? tx("私聊", "Direct")
                    : translateMemberLabel((selectedChannelWithLiveFeishuMembers ?? selectedChannel).memberLabel, tx),
                avatar: selectedChannel.avatarLabel ?? "群",
                avatarId: selectedChannel.humanContactUserId ?? selectedChannel.contactId ?? selectedChannel.channelName ?? selectedChannel.id,
                avatarName: selectedChannelWithLiveFeishuMembers?.displayName ?? selectedChannel.displayName ?? selectedChannel.name,
                avatarVariant: selectedChannel.directParticipantKind === "human" ? "human" : selectedChannel.kind === "direct" ? "agent" : "channel",
              }
            : null
        }
        selectedItemId={selectedChannelId}
        customThreadContent={
          selectedChannel
            ? isContactDirectoryContext
              ? (
                  <DigitalEmployeeDirectoryDetail
                    channel={selectedChannel}
                    hasConversation={Boolean(selectedConversationChannelName)}
                    lastMessage={translateChannelListPreview(selectedChannel.lastMessage, tx)}
                    tx={tx}
                  />
                )
              : selectedChannelRequiresAccess
              ? (
                  <ChannelAccessGate
                    accessState={selectedChannel.accessState ?? "requestable"}
                    channelName={selectedChannel.displayName ?? selectedChannel.name}
                    feedback={accessRequestFeedback}
                    pending={isPending}
                    tx={tx}
                    onRequestAccess={() => {
                      startTransition(async () => {
                        try {
                          setAccessRequestFeedback(null);
                          await requestChannelAccessAction(selectedChannel.name, data.workspaceId);
                          refreshChannelModule(selectedConversationChannelName);
                        } catch (error) {
                          setAccessRequestFeedback(error instanceof Error ? error.message : tx("申请失败", "Request failed"));
                        }
                      });
                    }}
                  />
                )
              : !selectedDetailLoaded && selectedDetailLoading
                ? (
                    <ChannelDetailLoadingState
                      tab={activeTab}
                      tx={tx}
                    />
                  )
                : !selectedDetailLoaded && detailLoadError
                  ? (
                      <ChannelDetailErrorState
                        message={detailLoadError}
                        onRetry={() => {
                          if (!selectedConversationChannelName) {
                            return;
                          }
                          setDetailDataByChannelName((current) => {
                            const next = new Map(current);
                            next.delete(selectedConversationChannelName);
                            return next;
                          });
                          setDetailLoadError(null);
                        }}
                        tx={tx}
                      />
                    )
              : activeTab === "files"
              ? (
                  <ChannelFilesView
                    files={filteredChannelFiles}
                    feedback={fileFeedback}
                    onCreateDocument={(attachmentId, fileName) => {
                      startTransition(async () => {
                        try {
                          setDocumentFeedback(null);
                          const result = await createChannelDocumentFromAttachmentAction({
                            channelName: selectedConversationChannelName!,
                            attachmentId,
                            title: fileName.replace(/\.md$/i, ""),
                          });
                          setSelectedDocumentId(result.documentId);
                          setActiveTab("documents");
                          setDocumentsView("workspace");
                          pushChannelRoute(selectedChannel.id, {
                            tab: "documents",
                            documentId: result.documentId,
                          });
                          refreshChannelModule(selectedConversationChannelName);
                        } catch (error) {
                          setDocumentFeedback(error instanceof Error ? error.message : tx("导入失败", "Import failed"));
                        }
                      });
                    }}
                    onFileSearchChange={setFileSearch}
                    onDeleteFile={deleteChannelFile}
                    searchInputRef={fileSearchInputRef}
                    onUpload={() => fileUploadInputRef.current?.click()}
                    pending={isPending}
                    searchValue={fileSearch}
                    tx={tx}
                  />
                )
              : activeTab === "documents"
                ? documentsView === "workspace"
                  ? documentWorkbench
                  : (
                      <ChannelDocumentsOverview
                        archivedDocuments={archivedChannelDocuments}
                        documents={filteredChannelDocuments}
                        onCreateDocument={() => openFreshDocumentWorkspace()}
                        onDocumentSearchChange={setDocumentSearch}
                        searchInputRef={documentSearchInputRef}
                        onDeleteDocument={deleteChannelDocument}
                        onOpenDocument={(documentId) => {
                          setSelectedDocumentId(documentId);
                          setActiveTab("documents");
                          setDocumentsView("workspace");
                          pushChannelRoute(selectedChannel.id, {
                            tab: "documents",
                            documentId,
                          });
                        }}
                        pending={isPending}
                        searchValue={documentSearch}
                        tx={tx}
                      />
                    )
                : undefined
            : undefined
        }
      />

      {showContactRemarkEditor && selectedChannel?.kind === "direct" && selectedChannel.contactId ? (
        <DigitalContactRemarkModal
          contactId={selectedChannel.contactId}
          currentRemark={selectedChannel.displayName ?? selectedChannel.contactId}
          pending={isPending}
          tx={tx}
          onCancel={() => setShowContactRemarkEditor(false)}
          onSave={(remarkName) => {
            startTransition(async () => {
              await updateDigitalContactRemarkAction({
                contactId: selectedChannel.contactId!,
                remarkName,
              });
              setShowContactRemarkEditor(false);
              refreshChannelModule(selectedConversationChannelName);
            });
          }}
        />
      ) : null}

      <input
        hidden
        multiple
        onChange={(event) => {
          startTransition(async () => {
            await uploadChannelFiles(event.currentTarget.files);
            event.currentTarget.value = "";
            refreshChannelModule(selectedConversationChannelName);
          });
        }}
        ref={fileUploadInputRef}
        type="file"
      />
    </>
  );
}
