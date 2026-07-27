"use client";

import { type FocusEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logoutAndRedirectAction, switchWorkspaceAction } from "@/features/auth/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import {
  SidebarVisibilityProvider,
  type SidebarVisibilityState,
  useSidebarVisibility,
} from "@/features/dashboard/sidebar-visibility-provider";
import {
  buildWorkspaceModulePermissionVersion,
  scopeWorkspaceModuleCacheKey,
  useWorkspaceModuleCache,
  useWorkspaceModuleCacheScope,
  WorkspaceModuleCacheProvider,
} from "@/features/dashboard/workspace-module-cache";
import { useWorkspaceShellCounters } from "@/features/dashboard/use-workspace-shell-counters";
import {
  buildWorkspaceOnboardingStorageKey,
  WorkspaceOnboardingGuide,
  type WorkspaceOnboardingStep,
} from "@/features/dashboard/onboarding-guide";
import { WorkspaceModuleHost } from "@/features/dashboard/workspace-module-host";
import { WorkspaceModuleNavigationProvider } from "@/features/dashboard/workspace-module-navigation";
import { WorkspaceSwitcher } from "@/features/dashboard/workspace-switcher";
import { useWorkspaceModuleRouteState } from "@/features/dashboard/use-workspace-module-route-state";
import { isWorkspaceModuleLoaderId } from "@/features/dashboard/workspace-module-loader-types";
import { canUseWorkspaceClientModule } from "@/features/dashboard/workspace-workbench-flags";
import {
  buildWorkspaceModuleDataQuery,
  parseWorkspaceModuleHref,
} from "@/features/dashboard/workspace-module-route";
import {
  markWorkspaceModuleNavigationClick,
  measureWorkspaceModuleNavigationActive,
} from "@/features/dashboard/workspace-navigation-performance";
import { GlobalSearchDialog } from "@/features/search/global-search-dialog";
import {
  canAccessSettingsSection,
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionPath,
  isSettingsDetailSectionId,
} from "@/features/settings/settings-sections";
import type { AuthUser } from "@/features/auth/server-auth";
import type { StoredWorkspaceRecord, WorkspaceRole } from "@dofe-agent/db";
import type { WorkspaceShellData } from "@/features/dashboard/workspace-shell-data";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

export const WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY = "dofe-agent:workspace-sidebar-collapsed";

export function WorkspaceFrame({
  accessScope = "workspace",
  currentWorkspace,
  user,
  shell,
  workspaces,
  currentMembershipRole,
  children,
  channelNames,
}: {
  accessScope?: "workspace" | "channel";
  channelNames?: string[];
  currentWorkspace: StoredWorkspaceRecord;
  user: AuthUser;
  shell: WorkspaceShellData;
  workspaces: StoredWorkspaceRecord[];
  currentMembershipRole: WorkspaceRole;
  children: React.ReactNode;
}) {
  const cacheScope = useMemo(
    () => ({
      viewerIdentityVersion: user.id,
      permissionVersion: buildWorkspaceModulePermissionVersion({
        accessScope,
        role: currentMembershipRole,
        channelNames,
      }),
    }),
    [accessScope, channelNames, currentMembershipRole, user.id],
  );

  return (
    <SidebarVisibilityProvider>
      <WorkspaceModuleCacheProvider scope={cacheScope} workspaceId={currentWorkspace.id}>
        <WorkspaceFrameContent
          accessScope={accessScope}
          currentMembershipRole={currentMembershipRole}
          currentWorkspace={currentWorkspace}
          shell={shell}
          user={user}
          workspaces={workspaces}
        >
          {children}
        </WorkspaceFrameContent>
      </WorkspaceModuleCacheProvider>
    </SidebarVisibilityProvider>
  );
}

function WorkspaceFrameContent({
  accessScope,
  currentWorkspace,
  user,
  shell,
  workspaces,
  currentMembershipRole,
  children,
}: {
  accessScope: "workspace" | "channel";
  currentWorkspace: StoredWorkspaceRecord;
  user: AuthUser;
  shell: WorkspaceShellData;
  workspaces: StoredWorkspaceRecord[];
  currentMembershipRole: WorkspaceRole;
  children: React.ReactNode;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const moduleCache = useWorkspaceModuleCache();
  const moduleCacheScope = useWorkspaceModuleCacheScope();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const { visibility } = useSidebarVisibility();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    routeState,
    routeStateSource,
    navigateHrefLocally,
    setOptimisticRouteFromHref,
  } = useWorkspaceModuleRouteState(currentWorkspace.slug);
  const logicalPathname = routeState.appPath;
  const mode = routeState.agentsMode;
  const isSettingsPath = routeState.isSettingsPath;
  const knowledgeView = routeState.knowledgeView;
  const isConversationLayout = routeState.isConversationLayout;
  const isHumanContactsView = routeState.isHumanContactsView;
  const isDigitalContactsView = routeState.isDigitalContactsView;
  const canManageRuntimes = currentMembershipRole === "owner" || currentMembershipRole === "admin";
  const canConnectRuntimes = canManageRuntimes;
  const canViewRuntimes = canConnectRuntimes || canManageRuntimes || shell.directMessages.length > 0;
  const isChannelScopedGuest = accessScope === "channel";
  const accountRoleLabel = formatWorkspaceAccountRole(currentMembershipRole, tx);
  const { counters, refreshCounters } = useWorkspaceShellCounters({
    initialShell: shell,
    workspaceSlug: currentWorkspace.slug,
  });
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const searchKey = searchParams.toString();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setShowSearch((v) => !v);
        setMobileSidebarOpen(false);
      }
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname, searchKey]);

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true");
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // The visual state still works for the current session.
      }
      return next;
    });
  }, []);

  const sectionTitle =
    logicalPathname === "/inbox"
      ? tx("通知", "Feed")
      : logicalPathname === "/im"
        ? isDigitalContactsView
          ? tx("联系人", "Contacts")
          : tx("消息", "Messages")
        : logicalPathname === "/contacts"
          ? tx("真人联系人", "Human contacts")
          : logicalPathname === "/approvals"
            ? tx("审批", "Approvals")
            : logicalPathname === "/task/board"
              ? tx("项目看板", "Task Board")
            : logicalPathname === "/agents"
              ? mode === "container"
                ? tx("执行引擎管理", "Execution Engine Management")
                : mode === "showcase"
                  ? tx("数字员工展板", "Digital Employee Showcase")
                  : tx("员工管理", "AI Employee Management")
                : logicalPathname === "/knowledge"
                  ? knowledgeView === "documents"
                    ? tx("文档页面", "Document pages")
                    : tx("知识页面", "Knowledge pages")
                  : logicalPathname === "/performance"
                    ? tx("绩效看板", "Dashboard")
                    : logicalPathname === "/org-chart"
                      ? tx("架构图", "Chart View")
                      : logicalPathname === "/costs"
                        ? tx("费用总览", "Cost Overview")
                        : logicalPathname === "/tables"
                          ? tx("多维表格", "Data Tables")
                          : logicalPathname === "/automations"
                            ? tx("工作流规则", "Workflow Rules")
                            : logicalPathname === "/calendar"
                              ? tx("定时任务", "Schedules")
                              : logicalPathname === "/templates"
                                ? tx("模板库", "Template Library")
                : logicalPathname === "/skills"
                  ? tx("技能库", "Skills")
                  : isSettingsPath
                    ? tx("设置", "Settings")
                    : tx("工作台", "Workspace");
  const workspaceHref = (path: string): string => buildWorkspacePath(currentWorkspace.slug, path);
  const sidebarSignals = [
    {
      active: logicalPathname === "/task/board",
      icon: "taskBoard" as const,
      label: tx("打开任务", "Open tasks"),
      href: workspaceHref("/task/board"),
      value: counters.openTaskCount,
    },
    {
      active: logicalPathname === "/approvals",
      icon: "approvals" as const,
      label: tx("待审批", "Approvals"),
      href: workspaceHref("/approvals"),
      value: counters.pendingApprovalCount,
    },
    {
      active: logicalPathname === "/knowledge",
      icon: "knowledge" as const,
      label: tx("知识页", "Knowledge"),
      href: workspaceHref("/knowledge"),
      value: counters.knowledgePageCount,
    },
  ];
  const showCommunicationSidebarGroup = visibility.messages || visibility.channels || visibility.contacts;
  const showOperationsSidebarGroup = visibility.employeeManagement || (visibility.containers && canViewRuntimes);
  const showResourceSidebarGroup = visibility.skills || visibility.knowledge || visibility.market;
  const showBusinessSidebarGroup =
    visibility.performance ||
    visibility.orgChart ||
    visibility.costs ||
    visibility.tables ||
    visibility.automations ||
    visibility.calendar ||
    visibility.templates;
  const onboardingSteps = useMemo<WorkspaceOnboardingStep[]>(
    () => buildWorkspaceOnboardingSteps({
      canViewRuntimes,
      currentWorkspaceSlug: currentWorkspace.slug,
      isChannelScopedGuest,
      tx,
      visibility,
    }),
    [canViewRuntimes, currentWorkspace.slug, isChannelScopedGuest, tx, visibility],
  );
  const handleOnboardingActiveChange = useCallback((active: boolean) => {
    if (active) {
      setMobileSidebarOpen(true);
    }
  }, []);
  const handleOnboardingNavigate = useCallback((href: string) => {
    router.push(href);
    setMobileSidebarOpen(false);
  }, [router]);
  const prefetchWorkspaceModuleHref = useCallback((href: string) => {
    const parsedRouteState = parseWorkspaceModuleHref(href);
    if (
      !canUseWorkspaceClientModule(parsedRouteState.moduleId) ||
      (parsedRouteState.workspaceSlug && parsedRouteState.workspaceSlug !== currentWorkspace.slug) ||
      !isWorkspaceModuleLoaderId(parsedRouteState.moduleId)
    ) {
      return;
    }

    const dataQuery = buildWorkspaceModuleDataQuery(parsedRouteState);
    const queryKey = dataQuery.toString();
    const query = queryKey ? `?${queryKey}` : "";
    const cacheKey = scopeWorkspaceModuleCacheKey(
      {
        workspaceId: currentWorkspace.id,
        moduleId: parsedRouteState.moduleId,
        queryKey,
      },
      moduleCacheScope,
    );

    void moduleCache.load({
      cacheKey,
      loader: async ({ signal }) => {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(currentWorkspace.slug)}/modules/${parsedRouteState.moduleId}${query}`,
          { signal },
        );
        if (!response.ok) {
          throw new WorkspaceModulePrefetchError(response.status, await response.text());
        }
        const payload = await response.json() as { data: unknown };
        return payload.data;
      },
      forbidden: (error) => error instanceof WorkspaceModulePrefetchError && error.status === 403,
    }).catch(() => {});
  }, [currentWorkspace.id, currentWorkspace.slug, moduleCache, moduleCacheScope]);
  const handleWorkspaceModuleLinkPrefetch = useCallback((
    event: FocusEvent<HTMLAnchorElement> | MouseEvent<HTMLAnchorElement>,
  ) => {
    prefetchWorkspaceModuleHref(event.currentTarget.href);
  }, [prefetchWorkspaceModuleHref]);
  const handleWorkspaceSelect = useCallback((nextWorkspaceSlug: string) => {
    if (!nextWorkspaceSlug || nextWorkspaceSlug === currentWorkspace.slug) {
      return;
    }

    startTransition(async () => {
      await switchWorkspaceAction(nextWorkspaceSlug);
      const nextPath = logicalPathname === "/" ? "/im" : logicalPathname;
      const query = searchParams.toString();
      router.push(
        buildWorkspacePath(
          nextWorkspaceSlug,
          `${nextPath}${query ? `?${query}` : ""}`,
        ),
      );
      router.refresh();
    });
  }, [currentWorkspace.slug, logicalPathname, router, searchParams]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar || typeof IntersectionObserver !== "function") {
      return;
    }

    const prefetchedHrefs = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLAnchorElement)) {
          continue;
        }
        observer.unobserve(entry.target);
        if (prefetchedHrefs.has(entry.target.href)) {
          continue;
        }
        prefetchedHrefs.add(entry.target.href);
        prefetchWorkspaceModuleHref(entry.target.href);
      }
    }, {
      root: sidebar,
      rootMargin: "160px 0px",
      threshold: 0.01,
    });

    const observeSidebarLinks = (): void => {
      sidebar.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
        observer.observe(link);
      });
    };

    observeSidebarLinks();

    const mutationObserver = typeof MutationObserver === "function"
      ? new MutationObserver(observeSidebarLinks)
      : null;
    mutationObserver?.observe(sidebar, { childList: true, subtree: true });

    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [
    prefetchWorkspaceModuleHref,
    visibility,
  ]);

  const handleWorkspaceModuleLinkClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.href;
    const parsedRouteState = parseWorkspaceModuleHref(href);
    const canUseClientWorkbench =
      !shouldUseNativeLinkNavigation(event) &&
      canUseWorkspaceClientModule(parsedRouteState.moduleId) &&
      (!parsedRouteState.workspaceSlug || parsedRouteState.workspaceSlug === currentWorkspace.slug) &&
      isWorkspaceModuleLoaderId(parsedRouteState.moduleId);
    let nextRouteState;
    if (canUseClientWorkbench) {
      event.preventDefault();
      nextRouteState = navigateHrefLocally(href);
    } else {
      nextRouteState = setOptimisticRouteFromHref(href);
    }
    if (nextRouteState) {
      markWorkspaceModuleNavigationClick(nextRouteState);
    }
    setMobileSidebarOpen(false);
  }, [currentWorkspace.slug, navigateHrefLocally, setOptimisticRouteFromHref]);
  const handleWorkspaceModuleNavigate = useCallback((href: string, options?: { replace?: boolean }) => {
    const parsedRouteState = parseWorkspaceModuleHref(href);
    if (
      !canUseWorkspaceClientModule(parsedRouteState.moduleId) ||
      (parsedRouteState.workspaceSlug && parsedRouteState.workspaceSlug !== currentWorkspace.slug) ||
      !isWorkspaceModuleLoaderId(parsedRouteState.moduleId)
    ) {
      const nextRouteState = setOptimisticRouteFromHref(href);
      if (nextRouteState) {
        markWorkspaceModuleNavigationClick(nextRouteState);
      }
      return false;
    }

    const nextRouteState = navigateHrefLocally(href, { replace: options?.replace });
    if (nextRouteState) {
      markWorkspaceModuleNavigationClick(nextRouteState);
    }
    setMobileSidebarOpen(false);
    return true;
  }, [currentWorkspace.slug, navigateHrefLocally, setOptimisticRouteFromHref]);
  const fallbackToDefaultSettingsSection = useCallback(() => {
    const href = buildWorkspacePath(currentWorkspace.slug, getSettingsSectionPath(DEFAULT_SETTINGS_SECTION));
    const nextRouteState = navigateHrefLocally(href, { replace: true });
    if (nextRouteState) {
      measureWorkspaceModuleNavigationActive(nextRouteState);
    }
    setMobileSidebarOpen(false);
  }, [currentWorkspace.slug, navigateHrefLocally]);

  useEffect(() => {
    if (routeState.moduleId !== "settings") {
      return;
    }

    const requestedSection = routeState.settingsPath[0] ?? DEFAULT_SETTINGS_SECTION;
    if (
      !isSettingsDetailSectionId(requestedSection) ||
      !canAccessSettingsSection(currentMembershipRole, requestedSection)
    ) {
      fallbackToDefaultSettingsSection();
    }
  }, [
    currentMembershipRole,
    fallbackToDefaultSettingsSection,
    routeState.moduleId,
    routeState.settingsPath,
  ]);

  useEffect(() => {
    measureWorkspaceModuleNavigationActive(routeState);
  }, [routeState]);

  function switchConversationViewLocally(nextView: "all" | "direct"): void {
    if (logicalPathname !== "/im") {
      return;
    }

    const nextSearch = new URLSearchParams(searchParams.toString());
    if (nextView === "direct") {
      nextSearch.set("view", "direct");
    } else {
      nextSearch.delete("view");
    }
    nextSearch.delete("focus");
    nextSearch.delete("tab");
    nextSearch.delete("doc");

    const nextQuery = nextSearch.toString();
    const nextHref = workspaceHref(`/im${nextQuery ? `?${nextQuery}` : ""}`);
    if (!handleWorkspaceModuleNavigate(nextHref)) {
      router.push(nextHref, { scroll: false });
    }
    setMobileSidebarOpen(false);
  }

  return (
    <div
      className={`workspace-layout${sidebarCollapsed ? " workspace-layout--sidebar-collapsed" : ""}${mobileSidebarOpen ? " workspace-layout--sidebar-open" : ""}`}
      data-testid="workspace-layout"
    >
      {!isChannelScopedGuest ? (
        <GlobalSearchDialog
          agentOptions={shell.agents}
          onWorkspaceModuleNavigate={handleWorkspaceModuleNavigate}
          open={showSearch}
          onClose={() => setShowSearch(false)}
        />
      ) : null}

      <WorkspaceOnboardingGuide
        disabled={isChannelScopedGuest}
        onActiveChange={handleOnboardingActiveChange}
        onNavigate={handleOnboardingNavigate}
        steps={onboardingSteps}
        storageKey={buildWorkspaceOnboardingStorageKey(user.id, currentWorkspace.id)}
        tx={tx}
      />

      <button
        aria-label={tx("关闭侧边导航", "Close sidebar")}
        className="workspace-sidebar-overlay"
        onClick={() => setMobileSidebarOpen(false)}
        type="button"
      />

      <aside
        aria-label={tx("工作区导航", "Workspace navigation")}
        className={`workspace-sidebar${mobileSidebarOpen ? " workspace-sidebar--open" : ""}`}
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        data-testid="workspace-sidebar"
        ref={sidebarRef}
      >
        <div className="workspace-sidebar__top">
          <WorkspaceSwitcher
            currentWorkspace={currentWorkspace}
            disabled={isPending}
            organizationName={user.organizationName}
            workspaces={workspaces}
            onSelect={handleWorkspaceSelect}
            tx={tx}
          />
          <button
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? tx("展开侧边导航", "Expand sidebar") : tx("收起侧边导航", "Collapse sidebar")}
            className="workspace-square-button workspace-sidebar__collapse-button"
            onClick={toggleSidebarCollapsed}
            title={sidebarCollapsed ? tx("展开侧边导航", "Expand sidebar") : tx("收起侧边导航", "Collapse sidebar")}
            type="button"
          >
            <AppIcon name="arrowLeft" />
          </button>
          <button
            aria-label={tx("关闭侧边导航", "Close sidebar")}
            className="workspace-square-button workspace-sidebar__mobile-close"
            onClick={() => setMobileSidebarOpen(false)}
            title={tx("关闭侧边导航", "Close sidebar")}
            type="button"
          >
            <AppIcon name="close" />
          </button>
        </div>

        {!isChannelScopedGuest ? (
        <button
          aria-label={tx("打开全局搜索", "Open global search")}
          className="workspace-search workspace-search__field"
          data-onboarding-target="search"
          onClick={() => setShowSearch(true)}
          title={tx("搜索消息、任务、知识与文档", "Search messages, tasks, knowledge, and docs")}
          type="button"
        >
            <span className="workspace-search__icon">
              <AppIcon name="search" />
            </span>
            <span className="workspace-search__label">
              {tx("搜索消息、任务、知识与文档", "Search messages, tasks, knowledge, and docs")}
            </span>
            <span className="workspace-search__hint">⌘K</span>
        </button>
        ) : null}

        {!isChannelScopedGuest ? (
        <section className="workspace-sidebar__navigation-group workspace-sidebar__navigation-group--signals">
          <SidebarGroupLabel label={tx("待处理", "Needs attention")} />
          <div className="workspace-sidebar__signals" data-onboarding-target="signals" role="list">
            {sidebarSignals.map((signal) => (
              <div key={signal.label} role="listitem">
                <Link
                  aria-current={signal.active ? "page" : undefined}
                  className={`workspace-sidebar__signal${signal.active ? " workspace-sidebar__signal--active" : ""}`}
                  href={signal.href}
                  onClick={handleWorkspaceModuleLinkClick}
                  onFocus={handleWorkspaceModuleLinkPrefetch}
                  onMouseEnter={handleWorkspaceModuleLinkPrefetch}
                  title={signal.label}
                >
                  <span className="workspace-sidebar__signal-icon">
                    <AppIcon name={signal.icon} />
                  </span>
                  <span className="workspace-sidebar__signal-copy">
                    <small>{signal.label}</small>
                    {signal.value > 0 ? <strong className="workspace-sidebar__count">{signal.value}</strong> : null}
                  </span>
                </Link>
              </div>
            ))}
          </div>
        </section>
        ) : null}

        <div className="workspace-sidebar__content">
          {!isChannelScopedGuest && showCommunicationSidebarGroup ? (
            <SidebarGroupLabel label={tx("协作", "Collaboration")} />
          ) : null}

          {visibility.messages && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="feed">
              <SidebarSectionLink
                href={workspaceHref("/inbox")}
                icon="messages"
                label={tx("通知", "Feed")}
                count={counters.unreadNotificationCount}
                active={logicalPathname === "/inbox"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.approvals && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="approvals">
              <SidebarSectionLink
                href={workspaceHref("/approvals")}
                icon="approvals"
                label={tx("审批", "Approvals")}
                count={counters.pendingApprovalCount}
                active={logicalPathname === "/approvals"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.taskBoard && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="task-board">
              <SidebarSectionLink
                href={workspaceHref("/task/board")}
                icon="taskBoard"
                label={tx("项目看板", "Task Board")}
                count={counters.openTaskCount}
                active={logicalPathname === "/task/board"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.channels ? (
            <section className="workspace-sidebar__group" data-onboarding-target="messages">
              <SidebarSectionLink
                href={workspaceHref("/im")}
                icon="groups"
                label={tx("消息", "Messages")}
                count={counters.messageCount}
                active={logicalPathname === "/im" && !isDigitalContactsView}
                onClick={(event) => {
                  handleWorkspaceModuleLinkClick(event);
                  if (logicalPathname !== "/im") {
                    return;
                  }
                  event.preventDefault();
                  switchConversationViewLocally("all");
                }}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.contacts && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="contacts">
              <SidebarSectionLink
                href={workspaceHref("/contacts")}
                icon="contacts"
                label={tx("联系人", "Contacts")}
                count={counters.contactCount}
                active={isHumanContactsView || isDigitalContactsView}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {!isChannelScopedGuest && showOperationsSidebarGroup ? (
            <SidebarGroupLabel label={tx("数字员工", "Digital workforce")} />
          ) : null}

          {visibility.employeeManagement && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="agents">
              <SidebarSectionLink
                href={workspaceHref("/agents?mode=agent")}
                icon="agents"
                label={tx("员工管理", "AI Employee Management")}
                count={counters.agentCount}
                active={logicalPathname === "/agents" && mode === "agent"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.employeeManagement && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="digital-employee-showcase">
              <SidebarSectionLink
                href={workspaceHref("/agents?mode=showcase")}
                icon="agents"
                label={tx("数字员工展板", "Digital Employee Showcase")}
                count={counters.agentCount}
                active={logicalPathname === "/agents" && mode === "showcase"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.containers && canViewRuntimes && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="containers">
              <SidebarSectionLink
                href={workspaceHref("/agents?mode=container")}
                icon="containers"
                label={tx("执行引擎管理", "Execution Engine Management")}
                count={counters.runtimeCount}
                active={logicalPathname === "/agents" && mode === "container"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {!isChannelScopedGuest && showResourceSidebarGroup ? (
            <SidebarGroupLabel label={tx("能力资源", "Capabilities")} />
          ) : null}

          {visibility.skills && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="skills">
              <SidebarSectionLink
                href={workspaceHref("/skills")}
                icon="skills"
                label={tx("技能库", "Skills")}
                count={counters.skillCount}
                active={logicalPathname === "/skills"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.knowledge && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="knowledge">
              <SidebarSectionLink
                href={workspaceHref("/knowledge")}
                icon="knowledge"
                label={tx("知识库", "Knowledge")}
                count={counters.knowledgePageCount}
                active={logicalPathname === "/knowledge"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.market && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="market">
              <SidebarSectionLink
                href={workspaceHref("/market")}
                icon="market"
                label={tx("应用市场", "Runtime App Market")}
                active={logicalPathname === "/market"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {!isChannelScopedGuest && showBusinessSidebarGroup ? (
            <SidebarGroupLabel label={tx("业务工具", "Business tools")} />
          ) : null}

          {visibility.performance && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="performance">
              <SidebarSectionLink
                href={workspaceHref("/performance")}
                icon="performance"
                label={tx("绩效看板", "Dashboard")}
                active={logicalPathname === "/performance"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.orgChart && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="org-chart">
              <SidebarSectionLink
                href={workspaceHref("/org-chart")}
                icon="orgChart"
                label={tx("架构图", "Chart View")}
                active={logicalPathname === "/org-chart"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.costs && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="costs">
              <SidebarSectionLink
                href={workspaceHref("/costs")}
                icon="costs"
                label={tx("费用总览", "Cost Overview")}
                active={logicalPathname === "/costs"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.tables && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="tables">
              <SidebarSectionLink
                href={workspaceHref("/tables")}
                icon="tables"
                label={tx("多维表格", "Data Tables")}
                active={logicalPathname === "/tables"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.automations && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="automations">
              <SidebarSectionLink
                href={workspaceHref("/automations")}
                icon="automations"
                label={tx("工作流规则", "Workflow Rules")}
                active={logicalPathname === "/automations"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.calendar && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="calendar">
              <SidebarSectionLink
                href={workspaceHref("/calendar")}
                icon="calendar"
                label={tx("定时任务", "Schedules")}
                active={logicalPathname === "/calendar"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}

          {visibility.templates && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="templates">
              <SidebarSectionLink
                href={workspaceHref("/templates")}
                icon="templates"
                label={tx("模板库", "Template Library")}
                active={logicalPathname === "/templates"}
                onClick={handleWorkspaceModuleLinkClick}
                onPrefetch={handleWorkspaceModuleLinkPrefetch}
                showArrow={false}
              />
            </section>
          ) : null}
        </div>

        <footer className="workspace-sidebar__footer">
          <div className="workspace-account workspace-account--compact">
            {isChannelScopedGuest ? (
            <div className="workspace-account__entry">
              <GeneratedAvatar
                className="workspace-account__avatar"
                id={user.id}
                name={user.displayName}
                variant="human"
              />
              <div className="workspace-account__meta">
                <strong>{user.displayName}</strong>
                <span className="workspace-account__role">{tx("群访客", "Channel guest")}</span>
              </div>
            </div>
            ) : (
            <Link
              aria-label={tx("打开设置", "Open settings")}
              aria-current={isSettingsPath ? "page" : undefined}
              className={`workspace-account__entry${isSettingsPath ? " workspace-account__entry--active" : ""}`}
              data-onboarding-target="settings"
              href={workspaceHref("/settings")}
              onClick={handleWorkspaceModuleLinkClick}
              onFocus={handleWorkspaceModuleLinkPrefetch}
              onMouseEnter={handleWorkspaceModuleLinkPrefetch}
              prefetch={false}
              title={tx("打开设置", "Open settings")}
            >
              <GeneratedAvatar
                className="workspace-account__avatar"
                id={user.id}
                name={user.displayName}
                variant="human"
              />
              <div className="workspace-account__meta">
                <strong>{user.displayName}</strong>
                <span className="workspace-account__role">{accountRoleLabel}</span>
              </div>
            </Link>
            )}
            <form action={logoutAndRedirectAction}>
              <button
                aria-label={tx("退出登录", "Sign out")}
                className="workspace-circle-button workspace-circle-button--ghost"
                type="submit"
              >
                <AppIcon name="logout" />
              </button>
            </form>
          </div>
        </footer>
      </aside>

      <main className={`workspace-main${isConversationLayout ? " workspace-main--conversation" : ""}`} data-testid="workspace-main">
        <div className="workspace-mobile-bar">
          <button
            aria-label={tx("打开导航", "Open navigation")}
            className="workspace-square-button workspace-mobile-bar__button"
            onClick={() => setMobileSidebarOpen(true)}
            type="button"
          >
            <AppIcon name="menu" />
          </button>
          <div className="workspace-mobile-bar__title">
            <strong>{sectionTitle}</strong>
            <span>{user.displayName}</span>
          </div>
          {!isChannelScopedGuest ? (
          <button
            aria-label={tx("打开搜索", "Open search")}
            className="workspace-square-button workspace-mobile-bar__button"
            onClick={() => setShowSearch(true)}
            type="button"
          >
            <AppIcon name="search" />
          </button>
          ) : null}
        </div>
        <div className={`workspace-main__content${isConversationLayout ? " workspace-main__content--conversation" : ""}`}>
          <WorkspaceModuleNavigationProvider navigateWorkspaceModule={handleWorkspaceModuleNavigate}>
            <WorkspaceModuleHost
              routeState={routeState}
              routeStateSource={routeStateSource}
              workspaceId={currentWorkspace.id}
              workspaceSlug={currentWorkspace.slug}
              onModuleDataChanged={refreshCounters}
              onSettingsSectionForbidden={fallbackToDefaultSettingsSection}
            >
              {children}
            </WorkspaceModuleHost>
          </WorkspaceModuleNavigationProvider>
        </div>
      </main>
    </div>
  );
}

function shouldUseNativeLinkNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.currentTarget.target === "_blank"
  );
}

function buildWorkspaceOnboardingSteps({
  canViewRuntimes,
  currentWorkspaceSlug,
  isChannelScopedGuest,
  tx,
  visibility,
}: {
  canViewRuntimes: boolean;
  currentWorkspaceSlug: string;
  isChannelScopedGuest: boolean;
  tx: (zh: string, en: string) => string;
  visibility: SidebarVisibilityState;
}): WorkspaceOnboardingStep[] {
  if (isChannelScopedGuest) {
    return [];
  }

  const runtimeStep: WorkspaceOnboardingStep = visibility.containers && canViewRuntimes
    ? {
        body: tx(
          "先接入 Runtime。Runtime 是 AI员工 真正执行任务的环境；没有它，AI员工 只能被配置，不能开始工作。",
          "Start by connecting a Runtime. A Runtime is the execution environment that actually runs AI employee work; without it, AI employees can be configured but cannot work.",
        ),
        href: buildWorkspacePath(currentWorkspaceSlug, "/agents?mode=container&create=server"),
        icon: "containers",
        id: "bind-runtime",
        primaryActionLabel: tx("去绑定 Runtime", "Bind Runtime"),
        target: "containers",
        title: tx("1. 绑定 Runtime", "1. Bind Runtime"),
      }
    : {
        body: tx(
          "第一步需要可用 Runtime。当前账号看不到执行引擎入口，请联系工作区管理员绑定 Runtime 后再继续搭建 AI员工。",
          "The first step needs an available Runtime. This account cannot see the execution engine entry, so ask a workspace admin to bind a Runtime before building an AI employee.",
        ),
        icon: "containers",
        id: "bind-runtime",
        target: "agents",
        title: tx("1. 绑定 Runtime", "1. Bind Runtime"),
      };

  return [
    runtimeStep,
    {
      body: tx(
        "Runtime 在线后，再创建或绑定 AI员工。Runtime 负责执行，AI员工 是数字员工身份；两者绑定后才是一名可工作的 AI员工。",
        "After the Runtime is online, create or bind an AI employee. The Runtime executes work, while the AI employee is the digital employee identity; together they become a working AI employee.",
      ),
      href: buildWorkspacePath(currentWorkspaceSlug, "/agents?mode=agent"),
      icon: "agents",
      id: "runtime-to-agent",
      primaryActionLabel: tx("创建或绑定 AI员工", "Create or bind AI employee"),
      target: "agents",
      title: tx("2. 从 Runtime 到 AI员工", "2. Runtime to AI Employee"),
    },
    {
      body: tx(
        "为 AI员工 写清工作说明：负责什么、不要做什么、结果按什么格式交付。这里决定它的行为边界。",
        "Write the AI employee's working instructions: what it owns, what it should avoid, and how results should be delivered. This defines its behavior.",
      ),
      href: buildWorkspacePath(currentWorkspaceSlug, "/agents?mode=agent"),
      icon: "taskBoard",
      id: "configure-instructions",
      primaryActionLabel: tx("配置工作说明", "Configure instructions"),
      target: "agents",
      title: tx("3. 配置工作说明", "3. Configure Instructions"),
    },
    {
      body: tx(
        "给 AI员工 配置能力来源：技能决定它会用哪些工具，知识决定它能读取哪些长期上下文，群组和文档决定它在哪里协作。",
        "Configure capability sources: skills define the tools it can use, knowledge defines long-lived context, and groups or documents define where it collaborates.",
      ),
      href: buildWorkspacePath(currentWorkspaceSlug, "/skills"),
      icon: "skills",
      id: "configure-capabilities",
      primaryActionLabel: tx("配置技能和知识", "Configure skills and knowledge"),
      target: visibility.skills ? "skills" : "knowledge",
      title: tx("4. 配置能力来源", "4. Configure Capabilities"),
    },
    {
      body: tx(
        "最后完成一条真实对话。在消息里 @AI员工 发一个明确任务，观察执行状态、结果、通知和必要审批。",
        "Finish with a real conversation. Mention the AI employee in Messages with a concrete task, then watch execution status, results, notifications, and approvals if needed.",
      ),
      href: buildWorkspacePath(currentWorkspaceSlug, "/im"),
      icon: "groups",
      id: "first-conversation",
      primaryActionLabel: tx("开始第一条对话", "Start first conversation"),
      target: visibility.channels ? "messages" : "agents",
      title: tx("5. 完成一条对话", "5. Complete a Conversation"),
    },
  ];
}

function formatWorkspaceAccountRole(
  role: WorkspaceRole,
  tx: (zh: string, en: string) => string,
): string {
  switch (role) {
    case "owner":
      return tx("超级管理员", "Workspace owner");
    case "admin":
      return tx("管理员", "Administrator");
    default:
      return tx("成员", "Member");
  }
}

function SidebarGroupLabel({ label }: { label: string }) {
  return <h2 className="workspace-sidebar__group-label">{label}</h2>;
}

function SidebarSectionLink({
  icon,
  href,
  label,
  count,
  active,
  nativeNavigation = false,
  onClick,
  onPrefetch,
  showArrow = true,
}: {
  icon: AppIconName;
  href: string;
  label: string;
  count?: number;
  active: boolean;
  nativeNavigation?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onPrefetch?: (event: FocusEvent<HTMLAnchorElement> | MouseEvent<HTMLAnchorElement>) => void;
  showArrow?: boolean;
}) {
  const content = (
    <>
      <span className="workspace-sidebar__item-main">
        <span className="workspace-sidebar__section-icon">
          <AppIcon name={icon} />
        </span>
        <span>{label}</span>
      </span>
      {typeof count === "number" && count > 0 ? <small className="workspace-sidebar__count">{count}</small> : null}
      {showArrow ? (
        <span aria-hidden="true" className="workspace-sidebar__external-arrow">
          <AppIcon name="open" />
        </span>
      ) : null}
    </>
  );

  if (nativeNavigation) {
    return (
      <a
        aria-current={active ? "page" : undefined}
        className={`workspace-sidebar__section-link${active ? " workspace-sidebar__section-link--active" : ""}`}
        href={href}
        onClick={onClick}
        onFocus={onPrefetch}
        onMouseEnter={onPrefetch}
        title={label}
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`workspace-sidebar__section-link${active ? " workspace-sidebar__section-link--active" : ""}`}
      href={href}
      onClick={onClick}
      onFocus={onPrefetch}
      onMouseEnter={onPrefetch}
      prefetch={false}
      title={label}
    >
      {content}
    </Link>
  );
}

class WorkspaceModulePrefetchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message || `Workspace module prefetch failed with ${status}.`);
  }
}
