import type {
  AgentsPageData,
  ApprovalsPageData,
  AutomationsPageData,
  BudgetPageData,
  CalendarPageData,
  ChannelsPageData,
  CostPageData,
  DataTablesPageData,
  InboxPageData,
  KnowledgePageData,
  OrgChartPageData,
  SkillsPageData,
  TaskBoardPageData,
  TemplatesPageData,
} from "@/features/dashboard/data";
import {
  getAgentsPageData,
  getApprovalsPageData,
  getAutomationsPageData,
  getBudgetPageData,
  getCalendarPageData,
  getChannelListPageData,
  getChannelsPageData,
  getCostPageDataAsync,
  getDataTablesPageData,
  getInboxPageData,
  getKnowledgePageData,
  getOrgChartPageData,
  getPerformancePageData,
  getSkillsPageData,
  getTaskBoardPageData,
  getTemplatesPageData,
} from "@/features/dashboard/data";
import {
  getHumanContactsPageData,
  type HumanContactsPageData,
} from "@/features/contacts/human-contacts-data";
export {
  isWorkspaceModuleLoaderId,
  type WorkspaceModuleLoaderId,
} from "@/features/dashboard/workspace-module-loader-types";
import type { WorkspaceModuleLoaderId } from "@/features/dashboard/workspace-module-loader-types";
import type { WorkspaceModuleViewer } from "@/features/dashboard/workspace-module-loader-types";
import { loadMarketPageData } from "@/features/market/market-page-loader";
import type { MarketPageData } from "@/features/market/market-page-client";
import {
  loadSettingsPageData,
  resolveSettingsLoaderSection,
  type SettingsPageData,
} from "@/features/settings/settings-page-loader";
import { readWorkspaceSync, type WorkspaceRole } from "@dofe-agent/db";
import type { PerformanceDashboardData } from "@dofe-agent/services";

export type WorkspaceModuleLoaderData =
  | {
      moduleId: "agents";
      data: AgentsPageData;
    }
  | {
      moduleId: "approvals";
      data: ApprovalsPageData;
    }
  | {
      moduleId: "automations";
      data: AutomationsPageData;
    }
  | {
      moduleId: "calendar";
      data: CalendarPageData;
    }
  | {
      moduleId: "contacts";
      currentUserDisplayName: string;
      data: HumanContactsPageData;
    }
  | {
      moduleId: "costs";
      costs: CostPageData;
      budgets: BudgetPageData;
    }
  | {
      moduleId: "im";
      currentUserDisplayName: string;
      data: ChannelsPageData;
    }
  | {
      moduleId: "org-chart";
      data: OrgChartPageData;
    }
  | {
      moduleId: "performance";
      data: PerformanceDashboardData;
    }
  | {
      moduleId: "settings";
      data: SettingsPageData;
    }
  | {
      moduleId: "skills";
      data: SkillsPageData;
    }
  | {
      moduleId: "tables";
      data: DataTablesPageData;
    }
  | {
      moduleId: "inbox";
      data: InboxPageData;
    }
  | {
      moduleId: "knowledge";
      data: KnowledgePageData;
    }
  | {
      moduleId: "market";
      data: MarketPageData;
    }
  | {
      moduleId: "task-board";
      data: TaskBoardPageData;
    }
  | {
      moduleId: "templates";
      data: TemplatesPageData;
    };

export interface WorkspaceModuleLoaderOptions {
  accessScope?: "workspace" | "channel";
  channelNames?: string[];
  query?: URLSearchParams | string;
  settingsPath?: string[];
}

export interface WorkspaceModuleLoaderResult<TData extends WorkspaceModuleLoaderData = WorkspaceModuleLoaderData> {
  data: TData;
  meta: {
    durationMs: number;
  };
}

export async function loadWorkspaceModuleDataWithMeta<TModuleId extends WorkspaceModuleLoaderId>(
  moduleId: TModuleId,
  workspaceId: string,
  viewer?: WorkspaceModuleViewer,
  options: WorkspaceModuleLoaderOptions = {},
): Promise<WorkspaceModuleLoaderResult<Extract<WorkspaceModuleLoaderData, { moduleId: TModuleId }>>> {
  const startedAt = performance.now();
  const data = await loadWorkspaceModuleData(moduleId, workspaceId, viewer, options) as Extract<
    WorkspaceModuleLoaderData,
    { moduleId: TModuleId }
  >;
  return {
    data,
    meta: {
      durationMs: Math.round(performance.now() - startedAt),
    },
  };
}

export async function loadWorkspaceModuleData(
  moduleId: WorkspaceModuleLoaderId,
  workspaceId: string,
  viewer?: WorkspaceModuleViewer,
  options: WorkspaceModuleLoaderOptions = {},
): Promise<WorkspaceModuleLoaderData> {
  return readLoadtestWorkspaceModuleCache(
    buildWorkspaceModuleLoadCacheKey(moduleId, workspaceId, viewer, options),
    () => loadWorkspaceModuleDataUncached(moduleId, workspaceId, viewer, options),
  );
}

async function loadWorkspaceModuleDataUncached(
  moduleId: WorkspaceModuleLoaderId,
  workspaceId: string,
  viewer?: WorkspaceModuleViewer,
  options: WorkspaceModuleLoaderOptions = {},
): Promise<WorkspaceModuleLoaderData> {
  switch (moduleId) {
    case "agents":
      return {
        moduleId,
        data: getAgentsPageData({
          workspaceId,
          currentUserId: viewer?.id,
          currentMembershipRole: viewer?.role,
        }),
      };
    case "approvals":
      return {
        moduleId,
        data: getApprovalsPageData(workspaceId, viewer ? {
          userId: viewer.id,
          displayName: viewer.displayName,
          role: viewer.role,
        } : undefined),
      };
    case "automations":
      return {
        moduleId,
        data: getAutomationsPageData(workspaceId),
      };
    case "calendar":
      return {
        moduleId,
        data: getCalendarPageData(workspaceId),
      };
    case "contacts":
      return {
        moduleId,
        currentUserDisplayName: viewer?.displayName ?? "",
        data: getHumanContactsPageData({
          workspaceId,
          currentUserId: viewer?.id ?? "",
        }),
      };
    case "costs":
      return {
        moduleId,
        budgets: getBudgetPageData(workspaceId),
        costs: await getCostPageDataAsync("monthly", workspaceId),
      };
    case "im":
      return loadImWorkspaceModuleData(workspaceId, viewer, options);
    case "org-chart":
      return {
        moduleId,
        data: getOrgChartPageData(workspaceId),
      };
    case "performance":
      return {
        moduleId,
        data: getPerformancePageData(workspaceId),
      };
    case "settings":
      return {
        moduleId,
        data: await loadSettingsWorkspaceModuleData(workspaceId, viewer, options),
      };
    case "skills":
      return {
        moduleId,
        data: getSkillsPageData(workspaceId, viewer?.role),
      };
    case "tables":
      return {
        moduleId,
        data: getDataTablesPageData(workspaceId),
      };
    case "inbox":
      return {
        moduleId,
        data: getInboxPageData(workspaceId, viewer),
      };
    case "knowledge":
      return {
        moduleId,
        data: getKnowledgePageData(viewer?.displayName ?? "", workspaceId),
      };
    case "market":
      return {
        moduleId,
        data: await loadMarketPageData({
          workspaceId,
          canManage: viewer?.role === "owner" || viewer?.role === "admin",
        }),
      };
    case "task-board":
      return {
        moduleId,
        data: getTaskBoardPageData("status", workspaceId, viewer),
      };
    case "templates":
      return {
        moduleId,
        data: getTemplatesPageData(workspaceId),
      };
  }
}

interface WorkspaceModuleLoadCacheEntry {
  expiresAt: number;
  promise: Promise<WorkspaceModuleLoaderData>;
}

const workspaceModuleLoadCache = new Map<string, WorkspaceModuleLoadCacheEntry>();

function readLoadtestWorkspaceModuleCache(
  key: string,
  load: () => Promise<WorkspaceModuleLoaderData>,
): Promise<WorkspaceModuleLoaderData> {
  const ttlMs = readLoadtestWorkspaceModuleCacheTtlMs();
  if (ttlMs <= 0) {
    return load();
  }

  const now = Date.now();
  const cached = workspaceModuleLoadCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = load();
  const entry: WorkspaceModuleLoadCacheEntry = {
    expiresAt: now + ttlMs,
    promise,
  };
  workspaceModuleLoadCache.set(key, entry);
  promise.then(
    () => {
      entry.expiresAt = Date.now() + ttlMs;
    },
    () => {
      if (workspaceModuleLoadCache.get(key) === entry) {
        workspaceModuleLoadCache.delete(key);
      }
    },
  );
  return promise;
}

function readLoadtestWorkspaceModuleCacheTtlMs(): number {
  const configured = Number.parseInt(process.env.DOFE_AGENT_WORKSPACE_MODULE_LOAD_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return process.env.LOADTEST_MODE === "local" ? 2_000 : 0;
}

function buildWorkspaceModuleLoadCacheKey(
  moduleId: WorkspaceModuleLoaderId,
  workspaceId: string,
  viewer: WorkspaceModuleViewer | undefined,
  options: WorkspaceModuleLoaderOptions,
): string {
  const query = typeof options.query === "string" ? options.query : options.query?.toString() ?? "";
  return JSON.stringify([
    moduleId,
    workspaceId,
    viewer?.id ?? "",
    viewer?.role ?? "",
    viewer?.displayName ?? "",
    options.accessScope ?? "",
    options.channelNames ?? [],
    query,
    options.settingsPath ?? [],
  ]);
}

async function loadSettingsWorkspaceModuleData(
  workspaceId: string,
  viewer?: WorkspaceModuleViewer,
  options: {
    settingsPath?: string[];
  } = {},
): Promise<SettingsPageData> {
  const workspace = readWorkspaceSync(workspaceId);
  if (!workspace || !viewer) {
    throw new Error("Settings module requires a workspace and viewer.");
  }

  return await loadSettingsPageData({
    currentSessionId: viewer.sessionId,
    currentUser: {
      displayName: viewer.displayName,
      email: viewer.email,
      id: viewer.id,
    },
    currentWorkspace: workspace,
    role: viewer.role,
    section: resolveSettingsLoaderSection(options.settingsPath),
  });
}

export function loadImWorkspaceModuleData(
  workspaceId: string,
  viewer?: WorkspaceModuleViewer,
  options: {
    accessScope?: "workspace" | "channel";
    channelNames?: string[];
    query?: URLSearchParams | string;
  } = {},
): Extract<WorkspaceModuleLoaderData, { moduleId: "im" }> {
  const query = readWorkspaceModuleLoaderSearchParams(options.query);
  const detailSplitEnabled = isImOptimisticSwitchEnabled() && isImDetailSplitEnabled();
  const accessScope = options.accessScope ?? "workspace";
  const currentUserDisplayName = viewer?.displayName ?? "";
  const channelNames = accessScope === "channel" ? options.channelNames ?? [] : undefined;
  const focusedChannel = readWorkspaceModuleLoaderSearchValue(query, "focus");
  const data = detailSplitEnabled
    ? getChannelListPageData(
        currentUserDisplayName,
        workspaceId,
        viewer?.id,
        viewer?.role,
        {
          channelNames,
          initialDetailChannelNames:
            accessScope === "channel"
              ? options.channelNames ?? []
              : resolveLoadtestAwareInitialImDetailChannelNames({
                  focus: focusedChannel,
                  currentUserDisplayName,
                  workspaceId,
                  currentUserId: viewer?.id,
                  currentMembershipRole: viewer?.role,
                }),
        },
      )
    : getChannelsPageData(
        currentUserDisplayName,
        workspaceId,
        viewer?.id,
        viewer?.role,
        buildImChannelsPageDataOptions({
          accessScope,
          channelNames: options.channelNames,
        }),
      );

  return {
    moduleId: "im",
    currentUserDisplayName,
    data,
  };
}

function buildImChannelsPageDataOptions(input: {
  accessScope: "workspace" | "channel";
  channelNames?: string[];
}): Parameters<typeof getChannelsPageData>[4] {
  if (input.accessScope === "channel") {
    return { channelNames: input.channelNames ?? [] };
  }
  return undefined;
}

function readWorkspaceModuleLoaderSearchParams(input?: URLSearchParams | string): URLSearchParams {
  if (!input) {
    return new URLSearchParams();
  }
  if (typeof input === "string") {
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }
  return new URLSearchParams(input.toString());
}

function readWorkspaceModuleLoaderSearchValue(searchParams: URLSearchParams, key: string): string | undefined {
  return searchParams.get(key) ?? undefined;
}

function resolveLoadtestAwareInitialImDetailChannelNames(input: {
  focus?: string;
  currentUserDisplayName: string;
  workspaceId: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
}): string[] {
  if (process.env.LOADTEST_MODE === "local" && !input.focus) {
    return [];
  }
  return resolveInitialImDetailChannelNames(input);
}

function isImDetailSplitEnabled(): boolean {
  if (process.env.LOADTEST_MODE === "local") {
    return process.env.NEXT_PUBLIC_IM_DETAIL_SPLIT_ENABLED !== "0";
  }
  return process.env.NEXT_PUBLIC_IM_DETAIL_SPLIT_ENABLED === "1";
}

function isImOptimisticSwitchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IM_OPTIMISTIC_SWITCH_ENABLED !== "0";
}

function resolveInitialImDetailChannelNames(input: {
  focus?: string;
  currentUserDisplayName: string;
  workspaceId: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
}): string[] {
  const data = getChannelsPageData(
    input.currentUserDisplayName,
    input.workspaceId,
    input.currentUserId,
    input.currentMembershipRole,
    { detailChannelNames: [] },
  );
  if (input.focus) {
    const focused = data.channels.find((channel) => {
      if (input.focus === `channel:${channel.id}` || input.focus === `channel:${channel.channelName ?? channel.id}`) {
        return true;
      }
      if (channel.kind === "direct" && channel.contactId && input.focus === `contact:${channel.contactId}`) {
        return true;
      }
      if (channel.kind === "direct" && channel.humanContactUserId && input.focus === `human:${channel.humanContactUserId}`) {
        return true;
      }
      return false;
    });
    const focusedChannelName = resolveImDetailChannelName(focused);
    if (focusedChannelName) {
      return [focusedChannelName];
    }
  }
  const firstChannelName = resolveImDetailChannelName(data.channels[0]);
  return firstChannelName ? [firstChannelName] : [];
}

function resolveImDetailChannelName(channel: ChannelsPageData["channels"][number] | undefined): string | undefined {
  if (!channel) {
    return undefined;
  }
  return channel.channelName ?? (channel.kind === "direct" ? undefined : channel.name);
}
