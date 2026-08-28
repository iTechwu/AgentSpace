"use client";

// channels-page 组合 hooks：实时刷新 + 路由状态（3.4-3 拆分自 channels-page-client.tsx）。

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";

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

export interface ChannelThreadChangedEvent {
  channelName?: string;
  conversationId?: string;
  taskId?: string;
  lastSeq?: number;
}

export function useChannelRealtimeRefresh({
  workspaceId,
  channelName,
  enabled,
  onInvalidation,
  onOpenMontageChange,
  onThreadChange,
  refresh,
}: {
  workspaceId: string;
  channelName?: string | null;
  enabled: boolean;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
  onOpenMontageChange?: (event: { jobId: string; lastAppliedSequence?: number }) => void;
  onThreadChange?: (event: ChannelThreadChangedEvent) => boolean | Promise<boolean>;
  refresh: () => void;
}): void {
  const refreshTimerRef = useRef<number | null>(null);
  const onInvalidationRef = useRef(onInvalidation);
  const onOpenMontageChangeRef = useRef(onOpenMontageChange);
  const onThreadChangeRef = useRef(onThreadChange);
  const refreshRef = useRef(refresh);

  useEffect(() => {
    onInvalidationRef.current = onInvalidation;
    onOpenMontageChangeRef.current = onOpenMontageChange;
    onThreadChangeRef.current = onThreadChange;
    refreshRef.current = refresh;
  }, [onInvalidation, onOpenMontageChange, onThreadChange, refresh]);

  useEffect(() => {
    if (!enabled || !channelName?.trim() || typeof window.EventSource !== "function") {
      return;
    }

    const source = new window.EventSource(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelName)}/events`,
    );
    const invalidateChannel = (eventChannelName: string | undefined): void => {
      onInvalidationRef.current?.({
        workspaceId,
        resources: eventChannelName ? [{ type: "channel", id: eventChannelName }] : [{ type: "channel" }],
        shell: "counters",
      });
    };
    const scheduleFullRefresh = (): void => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        refreshRef.current();
      }, CHANNEL_REALTIME_REFRESH_DEBOUNCE_MS);
    };
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
      invalidateChannel(eventChannelName);
      scheduleFullRefresh();
    };
    const recoverChangedThread = (event: MessageEvent<string>): void => {
      let payload: ChannelThreadChangedEvent;
      try {
        payload = JSON.parse(event.data) as ChannelThreadChangedEvent;
      } catch {
        return;
      }
      if (payload.channelName && payload.channelName !== channelName) {
        return;
      }
      invalidateChannel(payload.channelName ?? channelName);
      const recover = onThreadChangeRef.current;
      if (!recover) {
        scheduleFullRefresh();
        return;
      }
      void Promise.resolve(recover(payload))
        .then((handled) => {
          if (!handled) {
            scheduleFullRefresh();
          }
        })
        .catch(scheduleFullRefresh);
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
    source.addEventListener("channel.thread.changed", recoverChangedThread as EventListener);
    source.addEventListener("openmontage.job.changed", refreshOpenMontageJob as EventListener);

    return () => {
      source.removeEventListener("channel.message.created", scheduleRefresh as EventListener);
      source.removeEventListener("channel.thread.changed", recoverChangedThread as EventListener);
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
  routePath,
  routeSearch,
  setRouteSearch,
  workspaceHref,
}: {
  activeTab: ChannelWorkspaceTab;
  channelById: Map<string, ChannelRecord>;
  navigateWorkspaceModule: (href: string, options?: { replace?: boolean }) => boolean;
  routePath: "/contacts" | "/im";
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
      nextSearch.delete("new");
      // 切换频道/员工时必须清除 conversation，避免把员工 A 的会话 ID 带到员工 B（docs §6）。
      nextSearch.delete("conversation");
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
      const nextHref = workspaceHref(`${routePath}?${nextRouteSearch}`);
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
    [activeTab, channelById, navigateWorkspaceModule, routePath, routeSearch, setRouteSearch, workspaceHref],
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
