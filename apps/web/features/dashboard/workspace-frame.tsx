"use client";

import { type FocusEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { logoutAndRedirectAction, switchWorkspaceAction } from "@/features/auth/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { createChannelAction } from "@/features/channels/actions";
import { CreateChannelModal } from "@/features/channels/create-channel-modal";
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
import type { StoredWorkspaceRecord, WorkspaceRole } from "@agent-space/db";
import type { WorkspaceShellData } from "@/features/dashboard/workspace-shell-data";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

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
  const conversationView = routeState.conversationView;
  const isSettingsPath = routeState.isSettingsPath;
  const knowledgeView = routeState.knowledgeView;
  const isConversationLayout = routeState.isConversationLayout;
  const isHumanContactsView = routeState.isHumanContactsView;
  const isDigitalContactsView = routeState.isDigitalContactsView;
  const canManageRuntimes = currentMembershipRole === "owner" || currentMembershipRole === "admin";
  const canConnectRuntimes = currentMembershipRole === "owner" || currentMembershipRole === "admin" || currentMembershipRole === "member";
  const canViewRuntimes = canConnectRuntimes || canManageRuntimes || shell.directMessages.length > 0;
  const isChannelScopedGuest = accessScope === "channel";
  const { counters, refreshCounters } = useWorkspaceShellCounters({
    initialShell: shell,
    workspaceSlug: currentWorkspace.slug,
  });
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showApprovals, setShowApprovals] = useState(false);
  const [showTaskBoard, setShowTaskBoard] = useState(false);
  const [showContacts, setShowContacts] = useState(isHumanContactsView || isDigitalContactsView);
  const [showKnowledge, setShowKnowledge] = useState(false);
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
    if (isHumanContactsView || isDigitalContactsView) {
      setShowContacts(true);
    }
  }, [isDigitalContactsView, isHumanContactsView]);

  const sectionTitle =
    logicalPathname === "/inbox"
      ? tx("通知", "Feed")
      : logicalPathname === "/im"
        ? conversationView === "direct"
          ? tx("数字联系人", "Digital contacts")
          : tx("消息", "Messages")
        : logicalPathname === "/contacts"
          ? tx("真人联系人", "Human contacts")
          : logicalPathname === "/approvals"
            ? tx("审批", "Approvals")
            : logicalPathname === "/task-board"
              ? tx("项目看板", "Task Board")
            : logicalPathname === "/agents"
              ? mode === "container"
                ? tx("执行引擎管理", "Execution Engine Management")
                : mode === "showcase"
                  ? tx("数字员工展板", "Digital Employee Showcase")
                  : tx("员工管理", "Agent Management")
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
      icon: "taskBoard" as const,
      label: tx("打开任务", "Open tasks"),
      href: workspaceHref("/task-board"),
      value: counters.openTaskCount,
    },
    {
      icon: "approvals" as const,
      label: tx("待审批", "Approvals"),
      href: workspaceHref("/approvals"),
      value: counters.pendingApprovalCount,
    },
    {
      icon: "knowledge" as const,
      label: tx("知识页", "Knowledge"),
      href: workspaceHref("/knowledge"),
      value: counters.knowledgePageCount,
    },
  ];
  const showCommunicationSidebarGroup = visibility.messages || visibility.channels || visibility.contacts;
  const showOperationsSidebarGroup = visibility.employeeManagement || (visibility.containers && canViewRuntimes);
  const showResourceSidebarGroup = visibility.skills || visibility.knowledge || visibility.market;
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
    showApprovals,
    showContacts,
    showKnowledge,
    showTaskBoard,
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
      isSettingsDetailSectionId(requestedSection) &&
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
    <div className={`workspace-layout${mobileSidebarOpen ? " workspace-layout--sidebar-open" : ""}`} data-testid="workspace-layout">
      {!isChannelScopedGuest ? (
        <GlobalSearchDialog
          agentOptions={shell.agents}
          onWorkspaceModuleNavigate={handleWorkspaceModuleNavigate}
          open={showSearch}
          onClose={() => setShowSearch(false)}
        />
      ) : null}

      {showCreateChannel ? (
        <CreateChannelModal
          candidates={shell.channelMemberCandidates.filter((candidate) => candidate.id !== user.displayName)}
          pending={isPending}
          onClose={() => setShowCreateChannel(false)}
          onSubmit={(input) => {
            startTransition(async () => {
              await createChannelAction(input);
              setShowCreateChannel(false);
            });
          }}
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

      <aside className={`workspace-sidebar${mobileSidebarOpen ? " workspace-sidebar--open" : ""}`} data-testid="workspace-sidebar" ref={sidebarRef}>
        <div className="workspace-sidebar__top">
          <GeneratedAvatar
            className="workspace-user-badge"
            id={user.id}
            name={user.displayName}
            variant="human"
          />
          <div className="workspace-sidebar__workspace-picker" data-onboarding-target="workspace-switcher">
            <label className="workspace-sidebar__workspace-label" htmlFor="workspace-switcher">
              {tx("SSO 工作区", "SSO workspace")}
            </label>
            <select
              className="workspace-sidebar__workspace-select"
              disabled={isPending || workspaces.length <= 1}
              id="workspace-switcher"
              onChange={(event) => {
                const nextWorkspaceId = event.currentTarget.value;
                if (!nextWorkspaceId || nextWorkspaceId === currentWorkspace.slug) {
                  return;
                }

                startTransition(async () => {
                  await switchWorkspaceAction(nextWorkspaceId);
                  const nextPath = logicalPathname === "/" ? "/im" : logicalPathname;
                  const query = searchParams.toString();
                  router.push(
                    buildWorkspacePath(
                      nextWorkspaceId,
                      `${nextPath}${query ? `?${query}` : ""}`,
                    ),
                  );
                  router.refresh();
                });
              }}
              value={currentWorkspace.slug}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!isChannelScopedGuest ? (
        <label className="workspace-search" data-onboarding-target="search">
          <span className="workspace-search__field">
            <span className="workspace-search__icon">
              <AppIcon name="search" />
            </span>
            <input
              onClick={() => setShowSearch(true)}
              onFocus={(e) => {
                e.currentTarget.blur();
                setShowSearch(true);
              }}
              placeholder={tx("搜索消息、任务、知识与文档", "Search messages, tasks, knowledge, and docs")}
              readOnly
              type="search"
            />
            <span className="workspace-search__hint">⌘K</span>
          </span>
        </label>
        ) : null}

        {!isChannelScopedGuest ? (
        <div className="workspace-sidebar__signals" data-onboarding-target="signals" role="list">
          {sidebarSignals.map((signal) => (
            <div key={signal.label} role="listitem">
              <Link
                className="workspace-sidebar__signal"
                href={signal.href}
                onClick={handleWorkspaceModuleLinkClick}
                onFocus={handleWorkspaceModuleLinkPrefetch}
                onMouseEnter={handleWorkspaceModuleLinkPrefetch}
              >
                <span className="workspace-sidebar__signal-icon">
                  <AppIcon name={signal.icon} />
                </span>
                <span className="workspace-sidebar__signal-copy">
                  <small>{signal.label}</small>
                  <strong>{signal.value}</strong>
                </span>
              </Link>
            </div>
          ))}
        </div>
        ) : null}

        <div className="workspace-sidebar__content">
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
              <SidebarSectionToggle
                icon="approvals"
                label={tx("审批", "Approvals")}
                count={counters.pendingApprovalCount}
                expanded={showApprovals}
                onToggle={() => setShowApprovals((current) => !current)}
              />
              {showApprovals ? (
                <nav className="workspace-shortcuts" aria-label="Approval navigation">
                  <SidebarShortcut
                    icon="approvals"
                    href={workspaceHref("/approvals")}
                    label={tx("审批列表", "Approval List")}
                    count={counters.pendingApprovalCount}
                    active={logicalPathname === "/approvals"}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                </nav>
              ) : null}
            </section>
          ) : null}

          {visibility.taskBoard && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="task-board">
              <SidebarSectionToggle
                icon="taskBoard"
                label={tx("项目看板", "Task Board")}
                count={counters.openTaskCount}
                expanded={showTaskBoard}
                onToggle={() => setShowTaskBoard((current) => !current)}
              />
              {showTaskBoard ? (
                <nav className="workspace-shortcuts" aria-label="Task board navigation">
                  <SidebarShortcut
                    icon="taskBoard"
                    href={workspaceHref("/task-board")}
                    label={tx("看板视图", "Board View")}
                    count={counters.openTaskCount}
                    active={logicalPathname === "/task-board"}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                </nav>
              ) : null}
            </section>
          ) : null}

          {visibility.channels ? (
            <section className="workspace-sidebar__group" data-onboarding-target="messages">
              <div className="workspace-sidebar__label-row">
                <SidebarSectionLink
                  href={workspaceHref("/im")}
                  icon="groups"
                  label={tx("消息", "Messages")}
                  count={counters.messageCount}
                  active={logicalPathname === "/im" && conversationView !== "direct"}
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
                {!isChannelScopedGuest ? (
                <button
                  aria-label={tx("创建群组", "Create group")}
                  className="workspace-square-button workspace-add-button"
                  onClick={() => setShowCreateChannel(true)}
                  type="button"
                >
                  <AppIcon name="plus" />
                </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {visibility.contacts && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="contacts">
              <SidebarSectionToggle
                icon="contacts"
                label={tx("联系人", "Contacts")}
                count={counters.contactCount}
                expanded={showContacts}
                onToggle={() => setShowContacts((current) => !current)}
              />
              {showContacts ? (
                <nav className="workspace-shortcuts" aria-label={tx("联系人导航", "Contacts navigation")}>
                  <SidebarShortcut
                    icon="contacts"
                    href={workspaceHref("/contacts")}
                    label={tx("真人联系人", "Human contacts")}
                    count={counters.humanContactCount}
                    active={isHumanContactsView}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                  <SidebarShortcut
                    icon="contacts"
                    href={workspaceHref("/im?view=direct")}
                    label={tx("数字联系人", "Digital contacts")}
                    count={counters.localAgentCount}
                    active={isDigitalContactsView}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                </nav>
              ) : null}
            </section>
          ) : null}

          {!isChannelScopedGuest && showCommunicationSidebarGroup && showOperationsSidebarGroup ? <SidebarGroupDivider /> : null}

          {visibility.employeeManagement && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="agents">
              <SidebarSectionLink
                href={workspaceHref("/agents?mode=agent")}
                icon="agents"
                label={tx("员工管理", "Agent Management")}
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
              <div className="workspace-sidebar__label-row">
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
                {canConnectRuntimes ? (
                  <Link
                    aria-label={tx("添加服务器", "Add server")}
                    className="workspace-square-button workspace-add-button"
                    href={workspaceHref("/agents?mode=container&create=server")}
                    onClick={handleWorkspaceModuleLinkClick}
                    onFocus={handleWorkspaceModuleLinkPrefetch}
                    onMouseEnter={handleWorkspaceModuleLinkPrefetch}
                    prefetch={false}
                  >
                    <AppIcon name="plus" />
                  </Link>
                ) : null}
              </div>
            </section>
          ) : null}

          {!isChannelScopedGuest && showOperationsSidebarGroup && showResourceSidebarGroup ? <SidebarGroupDivider /> : null}

          {visibility.skills && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="skills">
              <div className="workspace-sidebar__label-row">
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
                <Link
                  aria-label={tx("添加技能", "Add skill")}
                  className="workspace-square-button workspace-add-button"
                  href={workspaceHref("/skills?create=skill")}
                  onClick={handleWorkspaceModuleLinkClick}
                  onFocus={handleWorkspaceModuleLinkPrefetch}
                  onMouseEnter={handleWorkspaceModuleLinkPrefetch}
                  prefetch={false}
                >
                  <AppIcon name="plus" />
                </Link>
              </div>
            </section>
          ) : null}

          {visibility.knowledge && !isChannelScopedGuest ? (
            <section className="workspace-sidebar__group" data-onboarding-target="knowledge">
              <SidebarSectionToggle
                icon="knowledge"
                label={tx("知识库", "Knowledge")}
                count={counters.knowledgePageCount}
                expanded={showKnowledge}
                onToggle={() => setShowKnowledge((current) => !current)}
              />
              {showKnowledge ? (
                <nav className="workspace-shortcuts" aria-label="Knowledge navigation">
                  <SidebarShortcut
                    icon="knowledge"
                    href={workspaceHref("/knowledge")}
                    label={tx("知识页面", "Wiki Pages")}
                    count={counters.knowledgePageCount}
                    active={logicalPathname === "/knowledge" && knowledgeView === "knowledge"}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                  <SidebarShortcut
                    icon="knowledge"
                    href={workspaceHref("/knowledge?view=documents")}
                    label={tx("文档页面", "Document pages")}
                    active={logicalPathname === "/knowledge" && knowledgeView === "documents"}
                    onClick={handleWorkspaceModuleLinkClick}
                    onPrefetch={handleWorkspaceModuleLinkPrefetch}
                  />
                </nav>
              ) : null}
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
                <span>{tx("群访客", "Channel guest")}</span>
              </div>
            </div>
            ) : (
            <Link
              className="workspace-account__entry"
              data-onboarding-target="settings"
              href={workspaceHref("/settings")}
              onClick={handleWorkspaceModuleLinkClick}
              onFocus={handleWorkspaceModuleLinkPrefetch}
              onMouseEnter={handleWorkspaceModuleLinkPrefetch}
              prefetch={false}
            >
              <GeneratedAvatar
                className="workspace-account__avatar"
                id={user.id}
                name={user.displayName}
                variant="human"
              />
              <div className="workspace-account__meta">
                <strong>{user.displayName}</strong>
                <span>{tx("打开设置", "Open settings")}</span>
              </div>
            </Link>
            )}
            <form action={logoutAndRedirectAction}>
              <button className="workspace-circle-button workspace-circle-button--ghost" type="submit">
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
          "先接入 Runtime。Runtime 是 Agent 真正执行任务的环境；没有它，Agent 只能被配置，不能开始工作。",
          "Start by connecting a Runtime. A Runtime is the execution environment that actually runs agent work; without it, agents can be configured but cannot work.",
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
          "第一步需要可用 Runtime。当前账号看不到执行引擎入口，请联系工作区管理员绑定 Runtime 后再继续搭建 Agent。",
          "The first step needs an available Runtime. This account cannot see the execution engine entry, so ask a workspace admin to bind a Runtime before building an agent.",
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
        "Runtime 在线后，再创建或绑定 Agent。Runtime 负责执行，Agent 是数字员工身份；两者绑定后才是一名可工作的 Agent。",
        "After the Runtime is online, create or bind an agent. The Runtime executes work, while the agent is the digital employee identity; together they become a working agent.",
      ),
      href: buildWorkspacePath(currentWorkspaceSlug, "/agents?mode=agent"),
      icon: "agents",
      id: "runtime-to-agent",
      primaryActionLabel: tx("创建或绑定 Agent", "Create or bind agent"),
      target: "agents",
      title: tx("2. 从 Runtime 到 Agent", "2. Runtime to Agent"),
    },
    {
      body: tx(
        "为 Agent 写清工作说明：负责什么、不要做什么、结果按什么格式交付。这里决定它的行为边界。",
        "Write the agent's working instructions: what it owns, what it should avoid, and how results should be delivered. This defines its behavior.",
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
        "给 Agent 配置能力来源：技能决定它会用哪些工具，知识决定它能读取哪些长期上下文，群组和文档决定它在哪里协作。",
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
        "最后完成一条真实对话。在消息里 @Agent 发一个明确任务，观察执行状态、结果、通知和必要审批。",
        "Finish with a real conversation. Mention the agent in Messages with a concrete task, then watch execution status, results, notifications, and approvals if needed.",
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

function SidebarShortcut({
  icon,
  href,
  label,
  count,
  active,
  onClick,
  onPrefetch,
}: {
  icon: AppIconName;
  href: string;
  label: string;
  count?: number;
  active: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onPrefetch?: (event: FocusEvent<HTMLAnchorElement> | MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <Link
      className={`workspace-shortcut${active ? " workspace-shortcut--active" : ""}`}
      href={href}
      onClick={onClick}
      onFocus={onPrefetch}
      onMouseEnter={onPrefetch}
      prefetch={false}
    >
      <span className="workspace-sidebar__item-main">
        <span className="workspace-sidebar__section-icon">
          <AppIcon name={icon} />
        </span>
        <span>{label}</span>
      </span>
      {typeof count === "number" ? <small>{count}</small> : null}
    </Link>
  );
}


function SidebarGroupDivider() {
  return <div className="workspace-sidebar__group-divider" role="separator" aria-orientation="horizontal" />;
}

function SidebarSectionToggle({
  icon,
  label,
  count,
  expanded,
  onToggle,
}: {
  icon: AppIconName;
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button aria-expanded={expanded} className="workspace-sidebar__section-toggle" onClick={onToggle} type="button">
      <span className="workspace-sidebar__item-main">
        <span className="workspace-sidebar__section-icon">
          <AppIcon name={icon} />
        </span>
        <span>{label}</span>
      </span>
      {typeof count === "number" ? <small>{count}</small> : null}
      <span className={`workspace-sidebar__subgroup-caret${expanded ? " workspace-sidebar__subgroup-caret--open" : ""}`}>
        <AppIcon name="chevronDown" />
      </span>
    </button>
  );
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
      {typeof count === "number" ? <small>{count}</small> : null}
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
        className={`workspace-sidebar__section-link${active ? " workspace-sidebar__section-link--active" : ""}`}
        href={href}
        onClick={onClick}
        onFocus={onPrefetch}
        onMouseEnter={onPrefetch}
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      className={`workspace-sidebar__section-link${active ? " workspace-sidebar__section-link--active" : ""}`}
      href={href}
      onClick={onClick}
      onFocus={onPrefetch}
      onMouseEnter={onPrefetch}
      prefetch={false}
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
