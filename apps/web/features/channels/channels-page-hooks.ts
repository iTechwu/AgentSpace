"use client";

// channels-page 组合 hooks：实时刷新 + 路由状态（3.4-3 拆分自 channels-page-client.tsx）。

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
  CHANNEL_REALTIME_REFRESH_DEBOUNCE_MS,
} from "@/features/channels/channels-page-shared";
import type {
  ChannelRecord,
  ChannelRouteUpdateOptions,
  ChannelWorkspaceTab,
} from "@/features/channels/channels-page-shared";
import {
  buildChannelFocusValue,
  parseChannelRouteState,
  readCurrentChannelSearchParams,
  resolveSelectedChannelName,
} from "@/features/channels/channels-page-model";

export function useChannelRealtimeRefresh({
  workspaceId,
  channelName,
  enabled,
  onInvalidation,
  onOpenMontageChange,
  refresh,
}: {
  workspaceId: string;
  channelName?: string | null;
  enabled: boolean;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
  onOpenMontageChange?: (event: { jobId: string; lastAppliedSequence?: number }) => void;
  refresh: () => void;
}): void {
  const refreshTimerRef = useRef<number | null>(null);
  const onInvalidationRef = useRef(onInvalidation);
  const onOpenMontageChangeRef = useRef(onOpenMontageChange);
  const refreshRef = useRef(refresh);

  useEffect(() => {
    onInvalidationRef.current = onInvalidation;
    onOpenMontageChangeRef.current = onOpenMontageChange;
    refreshRef.current = refresh;
  }, [onInvalidation, onOpenMontageChange, refresh]);

  useEffect(() => {
    if (!enabled || !channelName?.trim() || typeof window.EventSource !== "function") {
      return;
    }

    const source = new window.EventSource(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelName)}/events`,
    );
    const scheduleRefresh = (event: MessageEvent<string>) => {
      let eventChannelName = channelName;
      try {
        const payload = JSON.parse(event.data) as { channelName?: string };
        if (payload.channelName && payload.channelName !== channelName) {
          return;
        }
        eventChannelName = payload.channelName ?? channelName;
      } catch {
        return;
      }
      onInvalidationRef.current?.({
        workspaceId,
        resources: eventChannelName ? [{ type: "channel", id: eventChannelName }] : [{ type: "channel" }],
        shell: "counters",
      });
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        refreshRef.current();
      }, CHANNEL_REALTIME_REFRESH_DEBOUNCE_MS);
    };
    const refreshOpenMontageJob = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          channelName?: string;
          jobId?: string;
          lastAppliedSequence?: number;
        };
        if (payload.channelName && payload.channelName !== channelName) {
          return;
        }
        if (!payload.jobId) {
          return;
        }
        onOpenMontageChangeRef.current?.({
          jobId: payload.jobId,
          lastAppliedSequence: payload.lastAppliedSequence,
        });
      } catch {
        return;
      }
    };

    source.addEventListener("channel.message.created", scheduleRefresh as EventListener);
    source.addEventListener("channel.thread.changed", scheduleRefresh as EventListener);
    source.addEventListener("openmontage.job.changed", refreshOpenMontageJob as EventListener);

    return () => {
      source.removeEventListener("channel.message.created", scheduleRefresh as EventListener);
      source.removeEventListener("channel.thread.changed", scheduleRefresh as EventListener);
      source.removeEventListener("openmontage.job.changed", refreshOpenMontageJob as EventListener);
      source.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [channelName, enabled, workspaceId]);
}

export function useChannelRouteState({
  activeTab,
  channelById,
  navigateWorkspaceModule,
  routeSearch,
  setRouteSearch,
  workspaceHref,
}: {
  activeTab: ChannelWorkspaceTab;
  channelById: Map<string, ChannelRecord>;
  navigateWorkspaceModule: (href: string, options?: { replace?: boolean }) => boolean;
  routeSearch: string;
  setRouteSearch: (value: string) => void;
  workspaceHref: (path: string) => string;
}) {
  const routeState = useMemo(() => parseChannelRouteState(routeSearch), [routeSearch]);

  const writeChannelRoute = useCallback(
    (
      historyMode: "push" | "replace",
      channelId: string,
      options?: ChannelRouteUpdateOptions,
    ) => {
      const targetChannel = channelById.get(channelId);
      const nextSearch = readCurrentChannelSearchParams(routeSearch);
      const nextTab = options?.tab ?? activeTab;
      nextSearch.set("focus", buildChannelFocusValue(targetChannel, channelId));
      if (nextTab === "messages") {
        nextSearch.delete("tab");
      } else {
        nextSearch.set("tab", nextTab);
      }
      if (nextTab === "documents" && options?.documentId && resolveSelectedChannelName(targetChannel ?? null)) {
        nextSearch.set("doc", options.documentId);
      } else {
        nextSearch.delete("doc");
      }
      const nextRouteSearch = nextSearch.toString();
      const nextHref = workspaceHref(`/im?${nextRouteSearch}`);
      const handledByWorkspace = navigateWorkspaceModule(
        nextHref,
        historyMode === "replace" ? { replace: true } : undefined,
      );
      if (!handledByWorkspace) {
        if (historyMode === "push") {
          window.history.pushState(window.history.state, "", nextHref);
        } else {
          window.history.replaceState(window.history.state, "", nextHref);
        }
      }
      setRouteSearch(nextRouteSearch);
    },
    [activeTab, channelById, navigateWorkspaceModule, routeSearch, setRouteSearch, workspaceHref],
  );

  const replaceChannelRoute = useCallback(
    (channelId: string, options?: ChannelRouteUpdateOptions) => writeChannelRoute("replace", channelId, options),
    [writeChannelRoute],
  );
  const pushChannelRoute = useCallback(
    (channelId: string, options?: ChannelRouteUpdateOptions) => writeChannelRoute("push", channelId, options),
    [writeChannelRoute],
  );

  return {
    routeState,
    replaceChannelRoute,
    pushChannelRoute,
  };
}
