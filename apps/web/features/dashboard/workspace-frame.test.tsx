import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_VISIBILITY,
  SIDEBAR_VISIBILITY_STORAGE_KEY,
  SIDEBAR_VISIBILITY_STORAGE_VERSION,
} from "@/features/dashboard/sidebar-visibility-provider";
import {
  buildWorkspaceOnboardingStorageKey,
  WORKSPACE_ONBOARDING_REPLAY_EVENT,
} from "@/features/dashboard/onboarding-guide";
import { WorkspaceFrame, WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY } from "@/features/dashboard/workspace-frame";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { PerformancePageClient } from "@/features/performance/performance-page-client";
import { ChannelsPageClient } from "@/features/channels/channels-page-client";
import { InboxPageClient } from "@/features/inbox/inbox-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { SettingsPageClient } from "@/features/settings/settings-page-client";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import type { AuthUser } from "@/features/auth/server-auth";
import type { ChannelsPageData, InboxPageData } from "@/features/dashboard/data";
import type { WorkspaceShellData } from "@/features/dashboard/workspace-shell-data";
import type { ActionToastResult } from "@/shared/lib/toast-action";
import type { PerformanceDashboardData } from "@dofe-agent/services";

const searchParams = new URLSearchParams();
let pathname = "/inbox";
const routerPushMock = vi.fn();
const mockMoveTaskToColumnAction = vi.hoisted(() =>
  vi.fn<(taskId: string, status: string) => Promise<ActionToastResult<undefined>>>(async () => ({ data: undefined })),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    refresh: vi.fn(),
  }),
  usePathname: () => pathname,
  useSearchParams: () => ({
    get: (key: string) => searchParams.get(key),
    toString: () => searchParams.toString(),
  }),
}));

vi.mock("@/features/auth/actions", () => ({
  joinWorkspaceByCodeAction: vi.fn(async () => ({ ok: true, workspaceSlug: "workspace-beta", alreadyMember: false })),
  logoutAndRedirectAction: vi.fn(async () => {}),
  switchWorkspaceAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/features/channels/actions", () => ({
  createChannelAction: vi.fn(async () => {}),
}));

vi.mock("@/features/channels/create-channel-modal", () => ({
  CreateChannelModal: () => null,
}));

vi.mock("@/features/search/global-search-dialog", () => ({
  GlobalSearchDialog: () => null,
}));

vi.mock("@/features/task-board/actions", () => ({
  moveTaskToColumnAction: mockMoveTaskToColumnAction,
}));

const user: AuthUser = {
  id: "user-1",
  organizationName: "Dofe Agent",
  displayName: "techwu",
  role: "admin",
  email: "techwu@example.com",
};

const shell: WorkspaceShellData = {
  organizationName: "Dofe Agent",
  humanMembers: 1,
  channelCount: 1,
  messageCount: 2,
  unreadNotificationCount: 3,
  openTaskCount: 2,
  pendingApprovalCount: 1,
  localAgentCount: 1,
  remoteAgentCount: 0,
  skillCount: 3,
  knowledgePageCount: 2,
  channels: [{ name: "general", memberLabel: "1 member" }],
  channelMemberCandidates: [],
  contactCount: 2,
  humanContacts: [{ id: "human-1", name: "Alice", subtitle: "PM" }],
  agents: [{ id: "agent-1", name: "Ops Bot", subtitle: "Support", status: "idle" }],
  directMessages: [{ id: "runtime-1", name: "Container A", subtitle: "Healthy", status: "idle" }],
};

const workspaces = [
  {
    id: "workspace-alpha",
    slug: "workspace-alpha",
    name: "Alpha Workspace",
    createdBy: "user-1",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  },
  {
    id: "workspace-beta",
    slug: "workspace-beta",
    name: "Beta Workspace",
    createdBy: "user-1",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  },
];

const performanceData: PerformanceDashboardData = {
  agents: [],
  totalTasks: 2,
  totalCompleted: 1,
  totalFailed: 0,
  overallCompletionRate: 0.5,
  overallErrorRate: 0,
  overallAvgResponseTimeMs: 1200,
};

const channelsData: ChannelsPageData = {
  workspaceId: "workspace-alpha",
  channels: [
    {
      id: "general",
      name: "general",
      memberLabel: "1 humans / 1 agents",
      humanMemberNames: ["techwu"],
      employeeNames: ["Ops Bot"],
      lastMessage: "hello",
      updatedAt: "10:00",
    },
  ],
  threads: [
    {
      channelName: "general",
      messages: [
        {
          id: "message-1",
          channel: "general",
          speaker: "Ops Bot",
          role: "agent",
          time: "10:00",
          summary: "hello",
          status: "completed",
        },
      ],
    },
  ],
  documents: [],
  documentRuns: [],
  documentConflicts: [],
  channelFiles: [],
  mentionCandidates: [],
  channelMemberCandidates: [],
  totalChannels: 1,
};

const inboxData: InboxPageData = {
  items: [],
  totalCount: 0,
  unreadCount: 0,
  notificationCount: 0,
  taskCount: 0,
  channelCount: 0,
  activityCount: 0,
};

function installIntersectionObserverMock(): {
  instances: Array<{
    callback: IntersectionObserverCallback;
    disconnect: ReturnType<typeof vi.fn>;
    observed: Element[];
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
  }>;
} {
  const instances: Array<{
    callback: IntersectionObserverCallback;
    disconnect: ReturnType<typeof vi.fn>;
    observed: Element[];
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
  }> = [];

  vi.stubGlobal("IntersectionObserver", vi.fn((callback: IntersectionObserverCallback) => {
    const instance = {
      callback,
      disconnect: vi.fn(),
      observed: [] as Element[],
      observe: vi.fn((element: Element) => {
        instance.observed.push(element);
      }),
      unobserve: vi.fn((element: Element) => {
        instance.observed = instance.observed.filter((observed) => observed !== element);
      }),
    };
    instances.push(instance);
    return instance;
  }));

  return { instances };
}

describe("WorkspaceFrame", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    pathname = "/inbox";
    routerPushMock.mockReset();
    mockMoveTaskToColumnAction.mockReset();
    mockMoveTaskToColumnAction.mockResolvedValue({ data: undefined });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    searchParams.delete("filter");
    searchParams.delete("focus");
    searchParams.delete("mode");
    searchParams.delete("view");
    searchParams.delete("context");
  });

  it("shows the compact default sidebar groups with clear hierarchy", async () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /通知/ })).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: /消息/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /联系人/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /员工管理/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /执行引擎管理/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /技能库/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /知识库/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /应用市场/ })).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /待审批/ })).toHaveAttribute("href", "/w/workspace-alpha/approvals");

    expect(screen.queryByRole("link", { name: /^审批/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^项目看板/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /绩效看板/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /模板库/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "待处理" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "协作" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数字员工" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "能力资源" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /通知/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("超级管理员")).toBeInTheDocument();
  });

  it("collapses the desktop sidebar and persists the preference", async () => {
    const userEventApi = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("button", { name: "收起侧边导航" }));

    expect(screen.getByTestId("workspace-layout")).toHaveClass("workspace-layout--sidebar-collapsed");
    expect(screen.getByTestId("workspace-sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
    expect(screen.getByRole("button", { name: "展开侧边导航" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "打开设置" })).toHaveAttribute("title", "打开设置");
  });

  it("hides sidebar sections that were disabled in settings", async () => {
    const userEventApi = userEvent.setup();
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        approvals: false,
        calendar: false,
        market: false,
      }),
    );

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /^审批/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /日历/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /应用市场/ })).not.toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: /通知/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /私聊消息/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /消息/ })).toHaveTextContent("2");
    expect(screen.getByRole("link", { name: /联系人/ })).toHaveTextContent("2");
    expect(screen.getByRole("link", { name: /员工管理/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /技能库/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /执行引擎管理/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /添加技能/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /添加服务器/ })).not.toBeInTheDocument();
    const workspaceSwitcher = screen.getByRole("button", { name: /切换团队工作区/ });
    expect(workspaceSwitcher).toHaveTextContent("Dofe Agent / Alpha Workspace");
    await userEventApi.click(workspaceSwitcher);
    expect(screen.getByRole("menuitemradio", { name: "Alpha Workspace" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Beta Workspace" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("general")).not.toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Ops Bot")).not.toBeInTheDocument();
    expect(screen.queryByText("Container A")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace content")).toBeInTheDocument();
  });

  it("keeps a single hierarchical team selectable without duplicating its name", async () => {
    const userEventApi = userEvent.setup();
    const hierarchicalWorkspace = {
      ...workspaces[0],
      name: "优惠豚 / 全体",
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame
          currentMembershipRole="owner"
          currentWorkspace={hierarchicalWorkspace}
          shell={shell}
          user={user}
          workspaces={[hierarchicalWorkspace]}
        >
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    const workspaceSwitcher = screen.getByRole("button", { name: "切换团队工作区" });
    expect(workspaceSwitcher).toHaveTextContent("优惠豚 / 全体");
    expect(workspaceSwitcher).not.toHaveTextContent("优惠豚 / 全体 / 优惠豚 / 全体");

    await userEventApi.click(workspaceSwitcher);

    expect(screen.getByRole("menuitemradio", { name: "优惠豚 / 全体" })).toHaveAttribute("aria-checked", "true");
  });

  it("links to the runtime app market from the sidebar", () => {
    pathname = "/w/workspace-alpha/market";

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const marketLink = screen.getByRole("link", { name: /应用市场/ });
    expect(marketLink).toHaveAttribute("href", "/w/workspace-alpha/market");
    expect(marketLink).toHaveClass("workspace-sidebar__section-link--active");
  });

  it("switches migrated modules locally before the Next route payload returns", async () => {
    pathname = "/w/workspace-alpha/im";
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const moduleResponse = () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "performance",
          data: {
            totalTasks: 2,
            overallCompletionRate: 0.5,
            overallErrorRate: 0,
            overallAvgResponseTimeMs: 1200,
            agents: [],
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /绩效看板/ }));

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /绩效看板/ })).toHaveClass("workspace-sidebar__section-link--active");
    expect(await screen.findByText("正在加载")).toBeInTheDocument();

    resolveFetch?.(moduleResponse());

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "AI员工 绩效看板" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-alpha/modules/performance",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(window.location.pathname).toBe("/w/workspace-alpha/performance");
  });

  it("falls back to Next route navigation when the client workbench flag is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_CLIENT_WORKBENCH_ENABLED", "0");
    pathname = "/w/workspace-alpha/im";
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const performanceLink = screen.getByRole("link", { name: /绩效看板/ });
    performanceLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEventApi.click(performanceLink);

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Workspace content")).toBeInTheDocument();
  });

  it("falls back to Next route navigation when a module workbench flag is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_MODULE_PERFORMANCE_CLIENT_ENABLED", "0");
    pathname = "/w/workspace-alpha/im";
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const performanceLink = screen.getByRole("link", { name: /绩效看板/ });
    performanceLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEventApi.click(performanceLink);

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Workspace content")).toBeInTheDocument();
  });

  it("uses the workbench loader for the task-board signal link", async () => {
    pathname = "/w/workspace-alpha/im";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "task-board",
          data: {
            tasks: [],
            columns: [],
            agents: [],
            channels: [],
            totalCount: 0,
            todoCount: 0,
            inProgressCount: 0,
            doneCount: 0,
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /打开任务/ }));

    expect(routerPushMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/task-board",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(window.location.pathname).toBe("/w/workspace-alpha/task/board");
  });

  it("prefetches module data on sidebar hover and reuses it on click", async () => {
    pathname = "/w/workspace-alpha/im";
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "performance",
          data: {
            totalTasks: 2,
            overallCompletionRate: 0.5,
            overallErrorRate: 0,
            overallAvgResponseTimeMs: 1200,
            agents: [],
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const performanceLink = screen.getByRole("link", { name: /绩效看板/ });
    await userEventApi.hover(performanceLink);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/performance",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEventApi.click(performanceLink);

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "AI员工 绩效看板" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/w/workspace-alpha/performance");
  });

  it("prefetches visible sidebar module links through the viewport observer", async () => {
    pathname = "/w/workspace-alpha/im";
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "performance",
          data: performanceData,
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const intersectionObserver = installIntersectionObserverMock();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const performanceLink = await screen.findByRole("link", { name: /绩效看板/ });
    let observer = intersectionObserver.instances.find((instance) => instance.observed.includes(performanceLink));
    await waitFor(() => {
      observer = intersectionObserver.instances.find((instance) => instance.observed.includes(performanceLink));
      expect(observer).toBeTruthy();
    });

    await act(async () => {
      observer?.callback([
        {
          isIntersecting: true,
          target: performanceLink,
        } as unknown as IntersectionObserverEntry,
      ], observer as unknown as IntersectionObserver);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/performance",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("loads IM through the workbench and preserves its seeded composer draft across module switches", async () => {
    pathname = "/w/workspace-alpha/im";
    window.history.replaceState(null, "", "/w/workspace-alpha/im");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/inbox") {
        return new Response(JSON.stringify({
          data: {
            moduleId: "inbox",
            data: inboxData,
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/workspaces/workspace-alpha/modules/im") {
        return new Response(JSON.stringify({
          data: {
            moduleId: "im",
            currentUserDisplayName: "techwu",
            data: channelsData,
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{
                moduleId: "im",
                currentUserDisplayName: "techwu",
                data: channelsData,
              }}
              workspaceId={workspaces[0].id}
            >
              <ChannelsPageClient currentUserDisplayName="techwu" data={channelsData} />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const composer = await screen.findByPlaceholderText("发送到 general");
    await userEventApi.type(composer, "模块缓存草稿");
    await userEventApi.click(screen.getByRole("link", { name: /通知/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/inbox",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await userEventApi.click(screen.getByRole("link", { name: /消息/ }));

    expect(await screen.findByPlaceholderText("发送到 general")).toHaveValue("模块缓存草稿");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/workspaces/workspace-alpha/modules/im",
      expect.anything(),
    );
    expect(window.location.pathname).toBe("/w/workspace-alpha/im");
  });

  it("replaces inbox route content with IM module content when switching back to messages", async () => {
    pathname = "/w/workspace-alpha/inbox";
    window.history.replaceState(null, "", "/w/workspace-alpha/inbox");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/im") {
        return new Response(JSON.stringify({
          data: {
            moduleId: "im",
            currentUserDisplayName: "techwu",
            data: channelsData,
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{ moduleId: "inbox", data: inboxData }}
              workspaceId={workspaces[0].id}
            >
              <InboxPageClient data={inboxData} />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "通知" })).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("link", { name: /消息/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/im",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(await screen.findByPlaceholderText("发送到 general")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "通知" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/w/workspace-alpha/im");
  });

  it("does not keep workspace-scoped route content after switching to channel scope", async () => {
    pathname = "/w/workspace-alpha/im";
    window.history.replaceState(null, "", "/w/workspace-alpha/im");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{
                moduleId: "im",
                currentUserDisplayName: "techwu",
                data: channelsData,
              }}
              workspaceId={workspaces[0].id}
            >
              <ChannelsPageClient currentUserDisplayName="techwu" data={channelsData} />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(await screen.findByPlaceholderText("发送到 general")).toBeInTheDocument();

    view.rerender(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame
            accessScope="channel"
            channelNames={["guest-general"]}
            currentMembershipRole="member"
            currentWorkspace={workspaces[0]}
            shell={{
              ...shell,
              channels: [{ name: "guest-general", memberLabel: "channel guest" }],
              channelCount: 1,
              messageCount: 1,
            }}
            user={user}
            workspaces={workspaces}
          >
            <div>Guest route content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByText("Guest route content")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("发送到 general")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /消息/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /通知/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /联系人/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /员工管理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /技能库/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seeds the module cache from old route initial data", async () => {
    pathname = "/w/workspace-alpha/performance";
    window.history.replaceState(null, "", "/w/workspace-alpha/performance");
    window.localStorage.setItem(
      SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SIDEBAR_VISIBILITY,
        performance: true,
        __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
      }),
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "inbox",
          data: {
            items: [],
            totalCount: 0,
            unreadCount: 0,
            notificationCount: 0,
            taskCount: 0,
            channelCount: 0,
            activityCount: 0,
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{ moduleId: "performance", data: performanceData }}
              workspaceId={workspaces[0].id}
            >
              <PerformancePageClient data={performanceData} />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "AI员工 绩效看板" })).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("link", { name: /通知/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/inbox",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await userEventApi.click(screen.getByRole("link", { name: /绩效看板/ }));

    expect(screen.getByRole("heading", { name: "AI员工 绩效看板" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/workspaces/workspace-alpha/modules/performance",
      expect.anything(),
    );
  });

  it("refreshes sidebar counters after a workbench module action refresh", async () => {
    pathname = "/w/workspace-alpha/im";
    mockMoveTaskToColumnAction.mockResolvedValueOnce({
      data: undefined,
      invalidation: {
        workspaceId: "workspace-alpha",
        modules: ["task-board", "inbox", "agents"],
        resources: [{ type: "task", id: "task-1" }],
        shell: "counters",
      },
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    let taskBoardRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/task-board") {
        taskBoardRequests += 1;
        return new Response(JSON.stringify({
          data: {
            moduleId: "task-board",
            data: {
              tasks: [
                {
                  id: "task-1",
                  title: "整理行程",
                  channel: "travel",
                  assignee: "Atlas",
                  priority: "high",
                  status: "todo",
                },
              ],
              columns: [],
              agents: [],
              channels: [],
              totalCount: 1,
              todoCount: 1,
              inProgressCount: 0,
              doneCount: 0,
            },
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/workspaces/workspace-alpha/shell-counters") {
        return new Response(JSON.stringify({
          data: {
            humanMembers: 1,
            channelCount: 1,
            messageCount: 2,
            unreadNotificationCount: 3,
            openTaskCount: 1,
            pendingApprovalCount: 1,
            localAgentCount: 1,
            remoteAgentCount: 0,
            skillCount: 3,
            knowledgePageCount: 2,
            contactCount: 2,
            humanContactCount: 1,
            agentCount: 1,
            runtimeCount: 1,
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /打开任务/ }));
    const statusSelect = await screen.findByRole("combobox", { name: "更新任务状态" });
    expect(statusSelect).toBeInTheDocument();
    expect(screen.getByText("整理行程")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开任务/ })).toHaveTextContent("2");

    await userEventApi.selectOptions(statusSelect, "done");

    await waitFor(() => {
      expect(taskBoardRequests).toBeGreaterThanOrEqual(2);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/shell-counters",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByRole("link", { name: /打开任务/ })).toHaveTextContent("1");
    });
  });

  it("does not refresh sidebar counters for module-only invalidations", async () => {
    pathname = "/w/workspace-alpha/im";
    mockMoveTaskToColumnAction.mockResolvedValueOnce({
      data: undefined,
      invalidation: {
        workspaceId: "workspace-alpha",
        modules: ["task-board"],
      },
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    let taskBoardRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/task-board") {
        taskBoardRequests += 1;
        return new Response(JSON.stringify({
          data: {
            moduleId: "task-board",
            data: {
              tasks: [
                {
                  id: "task-1",
                  title: "整理行程",
                  channel: "travel",
                  assignee: "Atlas",
                  priority: "high",
                  status: "todo",
                },
              ],
              columns: [],
              agents: [],
              channels: [],
              totalCount: 1,
              todoCount: 1,
              inProgressCount: 0,
              doneCount: 0,
            },
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/workspaces/workspace-alpha/shell-counters") {
        throw new Error("Shell counters should not refresh for module-only invalidation.");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /打开任务/ }));
    const statusSelect = await screen.findByRole("combobox", { name: "更新任务状态" });
    await userEventApi.selectOptions(statusSelect, "done");

    await waitFor(() => {
      expect(taskBoardRequests).toBeGreaterThanOrEqual(2);
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/workspaces/workspace-alpha/shell-counters",
      expect.anything(),
    );
  });

  it("passes local URL query state into workbench-rendered modules", async () => {
    pathname = "/w/workspace-alpha/im";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "inbox",
          data: {
            items: [
              {
                id: "notification:one",
                kind: "notification",
                title: "系统通知",
                subtitle: "通知",
                meta: "now",
                timestamp: "now",
                unread: false,
                statusLabel: "done",
                statusTone: "positive",
                body: "hello",
                history: [],
              },
              {
                id: "task:one",
                kind: "task",
                title: "任务条目",
                subtitle: "任务",
                meta: "todo",
                timestamp: "now",
                unread: true,
                statusLabel: "todo",
                statusTone: "warning",
                body: "task",
                history: [],
              },
            ],
            totalCount: 2,
            unreadCount: 1,
            notificationCount: 1,
            taskCount: 1,
            channelCount: 0,
            activityCount: 0,
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const inboxLink = screen.getByRole("link", { name: /通知/ });
    inboxLink.setAttribute("href", "/w/workspace-alpha/inbox?filter=task");
    await userEventApi.click(inboxLink);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "任务" })).toHaveClass("filter-pill--active");
    });
    expect(screen.getAllByText("任务条目").length).toBeGreaterThan(0);
    expect(screen.queryByText("系统通知")).not.toBeInTheDocument();
  });

  it("switches settings sections through the workbench without remounting the settings shell", async () => {
    pathname = "/w/workspace-alpha/settings/preferences";
    window.history.replaceState(null, "", "/w/workspace-alpha/settings/preferences");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/settings?section=security") {
        return new Response(JSON.stringify({
          data: {
            moduleId: "settings",
            data: {
              currentMembershipRole: "owner",
              currentUserDisplayName: "techwu",
              currentUserEmail: "techwu@example.com",
              currentUserId: "user-1",
              currentWorkspaceName: "Alpha Workspace",
              currentWorkspaceSlug: "workspace-alpha",
              initialSection: "security",
              invitations: [],
              channelAccessRequests: [],
              channelInvitations: [],
              feishuAvailableChannels: [],
              feishuAvailableUsers: [],
              feishuAvailableAgents: [],
              feishuIntegrations: [],
              members: [
                {
                  userId: "user-1",
                  displayName: "techwu",
                  primaryEmail: "techwu@example.com",
                  role: "owner",
                },
              ],
              sessions: [],
            },
          },
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{
                moduleId: "settings",
                data: {
                  isSsoManagedWorkspace: true,
                  currentMembershipRole: "owner",
                  currentUserDisplayName: "techwu",
                  currentUserId: "user-1",
                  currentWorkspaceSlug: "workspace-alpha",
                  initialSection: "preferences",
                  feishuAvailableChannels: [],
                  feishuAvailableUsers: [],
                  feishuAvailableAgents: [],
                  feishuIntegrations: [],
                  sessions: [],
                },
              }}
              workspaceId={workspaces[0].id}
            >
              <>
                <div data-testid="settings-shell-marker">settings-shell-state</div>
                <SettingsPageClient
                  currentMembershipRole="owner"
                  currentUserDisplayName="techwu"
                  currentUserId="user-1"
                  currentWorkspaceSlug="workspace-alpha"
                  initialSection="preferences"
                />
              </>
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /安全与会话/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/settings?section=security",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: "安全与会话" }).length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("settings-shell-marker")).not.toBeVisible();
    expect(window.location.pathname).toBe("/w/workspace-alpha/settings/security");
  });

  it("falls back to preferences when the URL names an unknown settings section", async () => {
    window.localStorage.setItem(buildWorkspaceOnboardingStorageKey(user.id, workspaces[0].id), "done");
    pathname = "/w/workspace-alpha/settings/unknown";
    window.history.replaceState(null, "", "/w/workspace-alpha/settings/unknown");

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="member" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{
                moduleId: "settings",
                data: {
                  isSsoManagedWorkspace: true,
                  currentMembershipRole: "member",
                  currentUserDisplayName: "techwu",
                  currentUserId: "user-1",
                  currentWorkspaceSlug: "workspace-alpha",
                  initialSection: "preferences",
                  feishuAvailableChannels: [],
                  feishuAvailableUsers: [],
                  feishuAvailableAgents: [],
                  feishuIntegrations: [],
                  sessions: [],
                },
              }}
              workspaceId={workspaces[0].id}
            >
              <SettingsPageClient
                currentMembershipRole="member"
                currentUserDisplayName="techwu"
                currentUserId="user-1"
                currentWorkspaceSlug="workspace-alpha"
                initialSection="preferences"
              />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(window.location.pathname).toBe("/w/workspace-alpha/settings/preferences");
    });
    expect(screen.getByRole("heading", { name: "偏好设置" })).toBeInTheDocument();
  });

  it("falls back to preferences when settings loading becomes forbidden", async () => {
    pathname = "/w/workspace-alpha/settings/preferences";
    window.history.replaceState(null, "", "/w/workspace-alpha/settings/preferences");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/workspaces/workspace-alpha/modules/settings?section=security") {
        return new Response(JSON.stringify({ error: "Forbidden." }), {
          headers: { "Content-Type": "application/json" },
          status: 403,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <WorkspaceInitialModuleData
              moduleData={{
                moduleId: "settings",
                data: {
                  isSsoManagedWorkspace: true,
                  currentMembershipRole: "owner",
                  currentUserDisplayName: "techwu",
                  currentUserId: "user-1",
                  currentWorkspaceSlug: "workspace-alpha",
                  initialSection: "preferences",
                  feishuAvailableChannels: [],
                  feishuAvailableUsers: [],
                  feishuAvailableAgents: [],
                  feishuIntegrations: [],
                  sessions: [],
                },
              }}
              workspaceId={workspaces[0].id}
            >
              <SettingsPageClient
                currentMembershipRole="owner"
                currentUserDisplayName="techwu"
                currentUserId="user-1"
                currentWorkspaceSlug="workspace-alpha"
                initialSection="preferences"
              />
            </WorkspaceInitialModuleData>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /安全与会话/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/settings?section=security",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/w/workspace-alpha/settings/preferences");
    });
    expect(screen.getByRole("heading", { name: "偏好设置" })).toBeInTheDocument();
    expect(screen.queryByText("没有访问权限")).not.toBeInTheDocument();
  });

  it("shows the onboarding tour on first visit and stores completion when skipped", async () => {
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(await screen.findByRole("dialog", { name: "新手引导" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1. 绑定 Runtime" })).toBeInTheDocument();
    expect(screen.getByText(/没有它，AI员工 只能被配置，不能开始工作/)).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("button", { name: "跳过" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新手引导" })).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(buildWorkspaceOnboardingStorageKey(user.id, workspaces[0].id))).toBe("done");
  });

  it("guides setup from runtime binding to the first conversation", async () => {
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(await screen.findByRole("heading", { name: "1. 绑定 Runtime" })).toBeInTheDocument();
    await userEventApi.click(screen.getByRole("button", { name: "去绑定 Runtime" }));
    expect(routerPushMock).toHaveBeenCalledWith("/w/workspace-alpha/agents?mode=container&create=server");

    await userEventApi.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "2. 从 Runtime 到 AI员工" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建或绑定 AI员工" })).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "3. 配置工作说明" })).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "4. 配置能力来源" })).toBeInTheDocument();

    await userEventApi.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "5. 完成一条对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始第一条对话" })).toBeInTheDocument();
  });

  it("replays the onboarding tour from the workspace event", async () => {
    window.localStorage.setItem(buildWorkspaceOnboardingStorageKey(user.id, workspaces[0].id), "done");

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.queryByRole("dialog", { name: "新手引导" })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event(WORKSPACE_ONBOARDING_REPLAY_EVENT));
    });

    expect(await screen.findByRole("dialog", { name: "新手引导" })).toBeInTheDocument();
  });

  it("keeps direct digital conversations under Messages", () => {
    pathname = "/w/workspace-alpha/im";
    searchParams.set("view", "direct");

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /消息/ })).toHaveClass("workspace-sidebar__section-link--active");
    expect(screen.getByRole("link", { name: /联系人/ })).not.toHaveClass("workspace-sidebar__section-link--active");
  });

  it("highlights Contacts for the digital employee directory context", () => {
    pathname = "/w/workspace-alpha/im";
    searchParams.set("view", "direct");
    searchParams.set("context", "contacts");

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /联系人/ })).toHaveClass("workspace-sidebar__section-link--active");
    expect(screen.getByRole("link", { name: /消息/ })).not.toHaveClass("workspace-sidebar__section-link--active");
  });

  it("switches IM all and direct views through local module navigation", async () => {
    pathname = "/w/workspace-alpha/im";
    searchParams.set("view", "direct");
    window.history.replaceState(null, "", "/w/workspace-alpha/im?view=direct");
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /消息/ }));

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/w/workspace-alpha/im");
    expect(window.location.search).toBe("");
    expect(screen.getByRole("link", { name: /消息/ })).toHaveClass("workspace-sidebar__section-link--active");
  });

  it("hides execution engine management from regular members", () => {
    const memberShell: WorkspaceShellData = {
      ...shell,
      directMessages: [],
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="member" currentWorkspace={workspaces[0]} shell={memberShell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.queryByRole("link", { name: /执行引擎管理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /添加服务器/ })).not.toBeInTheDocument();
    expect(screen.getByText("成员")).toBeInTheDocument();
  });

  it("uses an explicit agent-mode link when leaving execution engine management", () => {
    pathname = "/w/workspace-alpha/agents";
    searchParams.set("mode", "container");

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /员工管理/ })).toHaveAttribute("href", "/w/workspace-alpha/agents?mode=agent");
    expect(screen.getByRole("link", { name: /数字员工展板/ })).toHaveAttribute("href", "/w/workspace-alpha/agents?mode=showcase");
  });

  it("keeps contacts as one stable sidebar destination", () => {
    pathname = "/w/workspace-alpha/im";

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /联系人/ })).toHaveTextContent("2");
    expect(screen.queryByRole("link", { name: /真人联系人/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /数字联系人/ })).not.toBeInTheDocument();
  });

  it("switches human contacts through the workbench loader", async () => {
    pathname = "/w/workspace-alpha/im";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          moduleId: "contacts",
          currentUserDisplayName: "techwu",
          data: {
            channels: ["general"],
            contacts: [
              {
                id: "human-1",
                name: "Alice",
                subtitle: "Member / alice@example.com",
                role: "Member",
              },
            ],
            threads: [{ contactId: "human-1", messages: [] }],
          },
        },
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const userEventApi = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
            <div>Workspace content</div>
          </WorkspaceFrame>
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await userEventApi.click(screen.getByRole("link", { name: /联系人/ }));

    expect(routerPushMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-alpha/modules/contacts",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
    });
    expect(window.location.pathname).toBe("/w/workspace-alpha/contacts");
  });

  it("highlights human contacts when the contacts directory is open", () => {
    pathname = "/w/workspace-alpha/contacts";

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /联系人/ })).toHaveClass("workspace-sidebar__section-link--active");
  });

  it("keeps knowledge as one stable sidebar destination", () => {
    pathname = "/w/workspace-alpha/knowledge";
    searchParams.set("view", "documents");

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByRole("link", { name: /知识库/i })).toHaveClass("workspace-sidebar__section-link--active");
    expect(screen.queryByRole("link", { name: /文档页面/i })).not.toBeInTheDocument();
  });

  it("keeps the settings section title for nested settings routes", () => {
    pathname = "/w/workspace-alpha/settings/security";

    render(
      <LanguageProvider initialLanguage="zh">
        <WorkspaceFrame currentMembershipRole="owner" currentWorkspace={workspaces[0]} shell={shell} user={user} workspaces={workspaces}>
          <div>Workspace content</div>
        </WorkspaceFrame>
      </LanguageProvider>,
    );

    expect(screen.getByText("设置")).toBeInTheDocument();
  });
});
