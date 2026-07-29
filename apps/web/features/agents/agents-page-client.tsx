"use client";

import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  acceptAgentForkInvitationAction,
  approveAgentAccessRequestAction,
  bindWorkspaceAgentRuntimeAction,
  cancelAgentAccessRequestAction,
  createContainerInstallTokenAction,
  createAgentAccessRequestAction,
  createAgentForkInvitationAction,
  createWorkspaceAgentAction,
  deleteWorkspaceAgentAction,
  deleteWorkspaceRuntimeAction,
  grantWorkspaceRuntimeUseAction,
  rejectAgentAccessRequestAction,
  revokeAgentForkInvitationAction,
  revokeWorkspaceRuntimeUseAction,
  setWorkspaceAgentChannelMemberAccessAction,
  setWorkspaceAgentKnowledgeAssignmentsAction,
  setWorkspaceAgentSkillAssignmentsAction,
  installWorkspaceAgentSkillAction,
  unbindWorkspaceAgentRuntimeAction,
  updateWorkspaceAgentDefaultModelAction,
  updateWorkspaceAgentInstructionsAction,
  updateWorkspaceRuntimeDisplayNameAction,
  verifyWorkspaceAgentRuntimeProviderAction,
} from "@/features/agents/actions";
import { useLanguage } from "@/features/i18n/language-provider";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { useWorkspaceModuleNavigation } from "@/features/dashboard/workspace-module-navigation";
import { EmptyState } from "@/shared/ui/empty-state";
import { InlineHelpTooltip } from "@/shared/ui/inline-help-tooltip";
import { runToastAction, type ActionToastResult } from "@/shared/lib/toast-action";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";
import { useResizablePane } from "@/shared/lib/use-resizable-pane";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AddContainerModal } from "@/features/agents/components/add-container-modal";
import { CreateAgentModal } from "@/features/agents/components/create-agent-modal";
import { AgentContactSection } from "@/features/agents/components/agent-contact-section";
import { ContainerOverview } from "@/features/agents/components/container-overview";
import { DaemonManagementPanel } from "@/features/agents/components/daemon-management-panel";
import { DigitalEmployeeShowcase } from "@/features/agents/components/digital-employee-showcase";
import { AgentAccessRequestModal } from "@/features/agents/components/agent-access-request-modal";
import { AgentDetail } from "@/features/agents/components/agent-detail";
import { toneForStatus, translateManagementStatus } from "@/features/agents/lib/translate";
import { buildWorkspacePath, parseWorkspacePathname } from "@/features/auth/workspace-paths";
import type { AgentsPageData, WorkspaceAgentForkInvitationView } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";
import { PaneResizeHandle } from "@/shared/ui/pane-resize-handle";

type Mode = "agent" | "showcase" | "container";
type RuntimeHostMode = "docker" | "local" | "remote";
type RuntimeServerGroup = {
  id: string;
  label: string;
  mode: RuntimeHostMode;
  containers: AgentsPageData["containers"];
};
const DAEMON_MANAGEMENT_SELECTION = "__daemon-management__";
const AGENTS_REFRESH_POLL_MS = 3000;
type GeneratedInstallCommandMode = "connect" | "update";

export function AgentsPageClient({
  data,
  moduleSearchParams,
  onDataChanged,
  onInvalidation,
}: {
  data: AgentsPageData;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
  onInvalidation?: (event: WorkspaceInvalidationEvent) => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const { navigateWorkspaceModule } = useWorkspaceModuleNavigation();
  const pathname = usePathname();
  const { workspaceSlug } = parseWorkspacePathname(pathname);
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const workspaceHref = useMemo(
    () => (path: string): string => workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : path,
    [workspaceSlug],
  );
  const canViewContainers = data.canConnectRuntimes || data.canManageRuntimes || data.containers.length > 0;
  const fallbackContainerSelection = data.containers[0]?.runtimeId ?? (data.canManageRuntimes ? DAEMON_MANAGEMENT_SELECTION : null);
  const requestedMode = searchParams.get("mode");
  const mode: Mode = requestedMode === "showcase"
    ? "showcase"
    : canViewContainers && requestedMode === "container"
      ? "container"
      : "agent";
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(
    fallbackContainerSelection,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(data.agents[0]?.id ?? null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [requestingShowcaseAgent, setRequestingShowcaseAgent] = useState<AgentsPageData["showcaseAgents"][number] | null>(null);
  const [generatedInstallCommand, setGeneratedInstallCommand] = useState<{
    command: string;
    daemonId: string;
    daemonTokenId: string;
    mode: GeneratedInstallCommandMode;
  } | null>(null);
  const [expandedRuntimeServerIds, setExpandedRuntimeServerIds] = useState<Set<string>>(() => new Set());
  const [forkAcceptDrafts, setForkAcceptDrafts] = useState<Record<string, { agentName: string; runtimeId: string }>>({});
  const [providerVerificationPendingRuntimeIds, setProviderVerificationPendingRuntimeIds] = useState<Set<string>>(() => new Set());
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [isPending, startTransition] = useTransition();
  const [isGeneratingContainerCommand, startGeneratingContainerCommand] = useTransition();
  const { pushToast } = useFeedbackToast();
  const pendingForkInvitations = data.pendingForkInvitations ?? [];
  const agentListPaneResize = useResizablePane({
    cssVariableName: "--workspace-list-width",
    defaultWidth: 360,
    maxWidth: 620,
    minWidth: 300,
    storageKey: "dofe-agent.agent-management-list-width",
  });
  const containerListPaneResize = useResizablePane({
    cssVariableName: "--workspace-list-width",
    defaultWidth: 360,
    maxWidth: 620,
    minWidth: 300,
    storageKey: "dofe-agent.execution-engine-list-width",
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const allAgents = useMemo(() => data.agents, [data.agents]);
  const runtimeServerGroups = useMemo(() => groupContainersByServer(data.containers), [data.containers]);
  const serverCount = useMemo(
    () => runtimeServerGroups.length || countDaemonServers(data.daemonSnapshots),
    [data.daemonSnapshots, runtimeServerGroups],
  );
  const boundAgents = useMemo(() => allAgents.filter((agent) => Boolean(agent.boundContainerId)), [allAgents]);
  const unboundAgents = useMemo(() => allAgents.filter((agent) => !agent.boundContainerId), [allAgents]);
  const isDaemonManagementSelected = selectedContainerId === DAEMON_MANAGEMENT_SELECTION;
  const selectedContainer = selectedContainerId
    && selectedContainerId !== DAEMON_MANAGEMENT_SELECTION
    ? data.containers.find((container) => container.runtimeId === selectedContainerId) ?? null
    : null;
  const selectedAgent = selectedAgentId ? allAgents.find((agent) => agent.id === selectedAgentId) ?? null : null;
  const shouldPollAgentUpdates = useMemo(
    () =>
      providerVerificationPendingRuntimeIds.size > 0
      ||
      data.daemonSnapshots.some((daemon) => daemon.status === "online")
      || data.containers.some((container) => container.queueCounts.running > 0 || container.queueCounts.queued > 0)
      || data.agents.some((agent) => agent.workAreas.some((area) => area.queueStatus === "queued" || area.queueStatus === "claimed" || area.queueStatus === "running")),
    [data.agents, data.containers, data.daemonSnapshots, providerVerificationPendingRuntimeIds],
  );
  useEffect(() => {
    setProviderVerificationPendingRuntimeIds((current) => {
      const next = new Set(
        [...current].filter((runtimeId) => data.agents.some((agent) =>
          agent.boundContainerId === runtimeId
          && (!agent.boundProviderHealth || agent.boundProviderHealth.providerUsable === "unverified")
        )),
      );
      return next.size === current.size ? current : next;
    });
  }, [data.agents]);
  const forkAcceptDraftById = useMemo(() => {
    const next: Record<string, { agentName: string; runtimeId: string }> = {};
    for (const invitation of pendingForkInvitations) {
      next[invitation.id] = forkAcceptDrafts[invitation.id] ?? {
        agentName: invitation.suggestedAgentName,
        runtimeId: data.containerOptions[0]?.id ?? "",
      };
    }
    return next;
  }, [data.containerOptions, pendingForkInvitations, forkAcceptDrafts]);

  useEffect(() => {
    const focus = searchParams.get("focus");
    if (!focus) return;

    if (focus === "daemon-management") {
      if (data.canManageRuntimes) {
        setSelectedContainerId(DAEMON_MANAGEMENT_SELECTION);
      }
      return;
    }

    if (focus.startsWith("runtime:")) {
      const runtimeId = focus.slice("runtime:".length);
      if (data.containers.some((container) => container.runtimeId === runtimeId)) {
        setSelectedContainerId(runtimeId);
      }
      return;
    }

    const agentFocus = focus.startsWith("agent:")
      ? focus
      : focus.startsWith("workspace:")
        ? `agent:${focus.slice("workspace:".length)}`
        : null;

    if (!agentFocus) return;

    const targetAgent = data.agents.find(
      (agent) => agent.id === agentFocus || agent.name === agentFocus.slice("agent:".length),
    );
    if (!targetAgent) return;

    setSelectedAgentId(targetAgent.id);
    if (targetAgent.boundContainerId && data.containers.some((container) => container.runtimeId === targetAgent.boundContainerId)) {
      setSelectedContainerId(targetAgent.boundContainerId);
    }
  }, [data.agents, data.canManageRuntimes, data.containers, searchParams]);

  useEffect(() => {
    if (mode === "container") {
      if (
        !selectedContainerId
        || (
          selectedContainerId !== DAEMON_MANAGEMENT_SELECTION
          && !data.containers.some((container) => container.runtimeId === selectedContainerId)
        )
      ) {
        setSelectedContainerId(fallbackContainerSelection);
      }
      return;
    }
    if (!selectedAgentId || !allAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(allAgents[0]?.id ?? null);
    }
  }, [allAgents, data.containers, fallbackContainerSelection, mode, selectedAgentId, selectedContainerId]);

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    if (mode === "agent" && !selectedAgent) {
      setMobilePane("list");
      return;
    }

    if (mode === "container" && !selectedContainer && !isDaemonManagementSelected) {
      setMobilePane("list");
    }
  }, [isCompactLayout, isDaemonManagementSelected, mode, selectedAgent, selectedContainer]);

  useAutoRefresh(shouldPollAgentUpdates, AGENTS_REFRESH_POLL_MS, onDataChanged);

  function runAction<T>(work: () => Promise<ActionToastResult<T>>, onDone?: (data: T) => void): void {
    startTransition(async () => {
      await runToastAction({
        action: work,
        onSuccess: async (data, result) => {
          onDone?.(data);
          if (result.invalidation) {
            onInvalidation?.(result.invalidation);
          }
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
        fallbackError: {
          zh: "请求失败，请稍后重试。",
          en: "Request failed. Please try again.",
        },
      });
    });
  }

  function handleSelectAgent(agentId: string): void {
    setSelectedAgentId(agentId);
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function handleSelectContainer(runtimeId: string): void {
    setSelectedContainerId(runtimeId);
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function toggleRuntimeServerGroup(groupId: string): void {
    setExpandedRuntimeServerIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function handleDeleteRuntime(runtimeId: string, runtimeName: string): void {
    if (!data.canManageRuntimes) {
      return;
    }
    const confirmed = window.confirm(
      tx(
        `删除执行引擎「${runtimeName}」？它的 Agent 绑定、分配记录和相关队列记录会一起清理。`,
        `Delete execution engine "${runtimeName}"? Agent bindings, assignments, and queued records for it will also be removed.`,
      ),
    );
    if (!confirmed) {
      return;
    }

    runAction(
      () => deleteWorkspaceRuntimeAction(runtimeId),
      () => {
        if (selectedContainerId === runtimeId) {
          const fallbackRuntimeId = data.containers.find((container) => container.runtimeId !== runtimeId)?.runtimeId;
          setSelectedContainerId(fallbackRuntimeId ?? (data.canManageRuntimes ? DAEMON_MANAGEMENT_SELECTION : null));
        }
      },
    );
  }

  function handleSelectDaemonManagement(): void {
    if (!data.canManageRuntimes) {
      return;
    }
    setSelectedContainerId(DAEMON_MANAGEMENT_SELECTION);
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function handleCreateContainerCommand(): void {
    if (!data.canConnectRuntimes) {
      return;
    }
    startGeneratingContainerCommand(async () => {
      try {
        const created = await createContainerInstallTokenAction();
        const origin = window.location.origin;
        const daemonId = `daemon-${Date.now().toString(36)}`;
        const command = buildCreateRuntimeCommand({
          origin,
          daemonToken: created.token,
          daemonKey: daemonId,
        });
        setGeneratedInstallCommand({
          command,
          daemonId,
          daemonTokenId: created.id,
          mode: "connect",
        });
      } catch (error) {
        pushToast({
          tone: "error",
          message: error instanceof Error ? error.message : tx("生成命令失败，请稍后重试。", "Failed to generate the install command. Please try again."),
        });
      }
    });
  }

  function handleUpdateRuntimeCommand(input: {
    daemonKey: string;
    runtimeId: string;
    deviceName?: string;
    runtimeName?: string;
  }): void {
    if (typeof window === "undefined") {
      return;
    }
    startGeneratingContainerCommand(async () => {
      try {
        const created = await createContainerInstallTokenAction();
        const origin = window.location.origin;
        const daemonSnapshot =
          data.daemonSnapshots.find((snapshot) =>
            snapshot.daemonKey === input.daemonKey && snapshot.runtimes.some((runtime) => runtime.id === input.runtimeId)
          )
          ?? data.daemonSnapshots.find((snapshot) => snapshot.daemonKey === input.daemonKey);
        setGeneratedInstallCommand({
          command: buildUpdateRuntimeCommand({
            origin,
            daemonToken: created.token,
            daemonKey: input.daemonKey,
            deviceName: daemonSnapshot?.deviceName ?? input.deviceName ?? input.daemonKey,
            runtimeName: input.runtimeName ?? daemonSnapshot?.runtimeName ?? "Remote Agent",
          }),
          daemonId: input.daemonKey,
          daemonTokenId: created.id,
          mode: "update",
        });
        if (isCompactLayout) {
          setMobilePane("detail");
        }
      } catch (error) {
        pushToast({
          tone: "error",
          message: error instanceof Error ? error.message : tx("生成命令失败，请稍后重试。", "Failed to generate the update command. Please try again."),
        });
      }
    });
  }

  useEffect(() => {
    if (mode !== "agent" || searchParams.get("create") !== "agent") {
      return;
    }

    if (data.canCreateAgent) {
      setShowCreateAgent(true);
    }
    const nextHref = workspaceHref("/agents?mode=agent");
    if (navigateWorkspaceModule(nextHref, { replace: true })) {
      return;
    }
    if (moduleSearchParams && typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", nextHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return;
    }
    router.replace(nextHref, { scroll: false });
  }, [data.canCreateAgent, mode, moduleSearchParams, navigateWorkspaceModule, router, searchParams, workspaceHref]);

  useEffect(() => {
    if (mode !== "container" || searchParams.get("create") !== "server" || generatedInstallCommand || isGeneratingContainerCommand) {
      return;
    }

    handleCreateContainerCommand();
    const nextHref = workspaceHref("/agents?mode=container");
    if (navigateWorkspaceModule(nextHref, { replace: true })) {
      return;
    }
    if (moduleSearchParams && typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", nextHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return;
    }
    router.replace(nextHref, { scroll: false });
  }, [generatedInstallCommand, isGeneratingContainerCommand, mode, moduleSearchParams, navigateWorkspaceModule, router, searchParams, workspaceHref]);

  const showListPane = !isCompactLayout || mobilePane === "list";
  const showDetailPane = !isCompactLayout || mobilePane === "detail";
  const detailTitle =
    mode === "agent"
      ? selectedAgent?.name ?? tx("AI员工 详情", "AI employee details")
      : mode === "showcase"
        ? tx("数字员工展板", "Digital employee showcase")
      : isDaemonManagementSelected
        ? tx("服务器管理", "Server Management")
        : selectedContainer?.name ?? tx("执行引擎详情", "Execution engine details");
  return (
    <section className={`page-shell agents-page agents-page--${mode}`}>
      {showCreateAgent ? (
        <CreateAgentModal
          containerOptions={data.containerOptions}
          canCreate={data.canCreateAgent}
          createRuntimeHref={data.canManageRuntimes ? workspaceHref("/runtimes") : undefined}
          defaultContainerId={selectedContainerId ?? ""}
          emptyRuntimeMessage={
            data.canManageAllAgents
              ? undefined
              : tx("请先接入自己的执行引擎，或联系管理员分配执行引擎。", "Connect your own execution engine first, or ask an admin to assign one.")
          }
          pending={isPending}
          requiresRuntime={!data.canManageAllAgents}
          workspaceSkills={data.workspaceSkills}
          onClose={() => setShowCreateAgent(false)}
          onSubmit={(input) =>
            runAction(
              () =>
                createWorkspaceAgentAction({
                  name: input.name,
                  remarkName: input.remarkName,
                  summary: input.summary,
                  instructions: input.instructions,
                  runtimeId: input.containerId || undefined,
                  defaultModel: input.defaultModel,
                  templateId: input.templateId,
                }),
              () => setShowCreateAgent(false),
            )
          }
        />
      ) : null}

      {requestingShowcaseAgent ? (
        <AgentAccessRequestModal
          agent={requestingShowcaseAgent}
          pending={isPending}
          tx={tx}
          onClose={() => setRequestingShowcaseAgent(null)}
          onSubmit={(draft) =>
            runAction(
              () =>
                createAgentAccessRequestAction({
                  sourceAgentName: requestingShowcaseAgent.internalName,
                  requestType: draft.requestType,
                  targetChannelName: draft.targetChannelName,
                  reason: draft.reason,
                }),
              () => setRequestingShowcaseAgent(null),
            )
          }
        />
      ) : null}

      {generatedInstallCommand ? (
        <AddContainerModal
          command={generatedInstallCommand.command}
          daemonId={generatedInstallCommand.daemonId}
          daemonTokenId={generatedInstallCommand.daemonTokenId}
          mode={generatedInstallCommand.mode}
          onClose={() => setGeneratedInstallCommand(null)}
          onSuccess={(runtimeId) => {
            const commandMode = generatedInstallCommand.mode;
            setGeneratedInstallCommand(null);
            if (runtimeId) {
              setSelectedContainerId(runtimeId);
            }
            pushToast({
              tone: "success",
              message: commandMode === "update" ? tx("Runtime 已更新并重新上线。", "The runtime updated and came back online.") : tx("新执行引擎已上线。", "The new execution engine is online."),
            });
            refreshWorkspaceModule(onDataChanged, router);
          }}
        />
      ) : null}

      {mode === "agent" ? (
        <div
          className={`agents-shell agents-shell--agent${isCompactLayout ? " agents-shell--compact" : ""}`}
          style={agentListPaneResize.paneStyle}
        >
          {showListPane ? (
            <aside className="page-panel agents-pane">
              <div className="panel-header">
                <div className="agents-pane__header-main">
                  <div className="agents-pane__title-row">
                    <h3>{data.canManageAllAgents ? tx("全部 AI员工", "All AI employees") : tx("我的 AI员工", "My AI employees")}</h3>
                    <div className="agents-pane__create-actions">
                      <button
                        className={`action-button${showCreateAgent ? " action-button--active" : ""}`}
                        disabled={!data.canCreateAgent}
                        onClick={() => setShowCreateAgent((value) => !value)}
                        type="button"
                      >
                        {tx("新建 AI员工", "New AI employee")}
                      </button>
                      <InlineHelpTooltip
                        label={tx("新建 AI员工 说明", "New AI employee help")}
                        tooltip={tx(
                          data.canManageAllAgents
                            ? "AI员工 可先创建，后续再绑定执行引擎和 skills。"
                            : "需要管理员先分配执行引擎，之后你可以创建并管理自己的 AI员工。",
                          data.canManageAllAgents
                            ? "Create an AI employee first, then bind its execution engine and skills."
                            : "An admin must assign an execution engine before you can create and manage your own AI employee.",
                        )}
                      />
                    </div>
                  </div>
                </div>
                <span className="panel-note">{allAgents.length}</span>
              </div>

              <div className="agents-contact-header">
                <strong>{tx("组织内联系人", "Directory")}</strong>
                <span>{tx("AI员工 目录", "AI employee directory")}</span>
              </div>

              {pendingForkInvitations.length > 0 ? (
                <AgentForkInvitationInbox
                  containerOptions={data.containerOptions}
                  drafts={forkAcceptDraftById}
                  invitations={pendingForkInvitations}
                  pending={isPending}
                  tx={tx}
                  onDraftChange={(invitationId, draft) =>
                    setForkAcceptDrafts((current) => ({
                      ...current,
                      [invitationId]: {
                        ...forkAcceptDraftById[invitationId],
                        ...draft,
                      },
                    }))
                  }
                  onAccept={(invitationId) => {
                    const draft = forkAcceptDraftById[invitationId];
                    if (!draft) return;
                    runAction(
                      () =>
                        acceptAgentForkInvitationAction({
                          invitationId,
                          newAgentName: draft.agentName,
                          runtimeId: draft.runtimeId,
                        }),
                      (result) => {
                        setSelectedAgentId(`agent:${result.agentName}`);
                        setForkAcceptDrafts((current) => {
                          const next = { ...current };
                          delete next[invitationId];
                          return next;
                        });
                        if (isCompactLayout) {
                          setMobilePane("detail");
                        }
                      },
                    );
                  }}
                />
              ) : null}

              <div className="agents-contact-list">
                {allAgents.length > 0 ? (
                  <>
                    {boundAgents.length > 0 ? (
                      <AgentContactSection
                        agents={boundAgents}
                        selectedAgentId={selectedAgent?.id ?? null}
                        title={tx("已绑定", "Bound")}
                        tx={tx}
                        onSelect={handleSelectAgent}
                      />
                    ) : null}
                    {unboundAgents.length > 0 ? (
                      <AgentContactSection
                        agents={unboundAgents}
                        selectedAgentId={selectedAgent?.id ?? null}
                        title={tx("未绑定", "Unbound")}
                        tx={tx}
                        onSelect={handleSelectAgent}
                      />
                    ) : null}
                  </>
                ) : (
                  <EmptyState body={tx("当前还没有任何 AI员工。", "There are no AI employees yet.")} title={tx("没有 AI员工", "No AI employees")} />
                )}
              </div>
            </aside>
          ) : null}

          {!isCompactLayout && showListPane && showDetailPane ? (
            <PaneResizeHandle
              label={tx("调整员工管理列表宽度", "Resize employee management list")}
              maxValue={agentListPaneResize.maxWidth}
              minValue={agentListPaneResize.minWidth}
              onKeyDown={agentListPaneResize.onHandleKeyDown}
              onPointerDown={agentListPaneResize.onHandlePointerDown}
              value={agentListPaneResize.width}
            />
          ) : null}

          {showDetailPane ? (
            <section className="page-panel agents-detail-pane">
              {isCompactLayout ? (
                <div className="agents-detail-pane__mobile-bar">
                  <button
                    aria-label={tx("返回列表", "Back to list")}
                    className="agents-detail-pane__back"
                  onClick={() => setMobilePane("list")}
                  type="button"
                >
                  <AppIcon name="arrowLeft" />
                </button>
                <div className="agents-detail-pane__mobile-copy">
                  <strong>{detailTitle}</strong>
                    <span>{tx("AI员工 详情", "AI employee details")}</span>
                  </div>
                </div>
              ) : null}
              {selectedAgent ? (
                <AgentDetail
                  containerOptions={data.containerOptions}
                  pending={isPending}
                  providerVerificationPending={Boolean(
                    selectedAgent.boundContainerId
                    && providerVerificationPendingRuntimeIds.has(selectedAgent.boundContainerId),
                  )}
                  record={selectedAgent}
                  workspaceMembers={data.workspaceMembers}
                  workspaceSkills={data.workspaceSkills}
                  onBindContainer={(runtimeId) =>
                    runAction(
                      () =>
                        bindWorkspaceAgentRuntimeAction({
                          employeeName: selectedAgent.internalName,
                          runtimeId,
                        }),
                    )
                  }
                  onUnbindContainer={() =>
                    runAction(
                      () => unbindWorkspaceAgentRuntimeAction(selectedAgent.internalName),
                    )
                  }
                  onVerifyProvider={() => {
                    if (!selectedAgent.boundContainerId) return;
                    runAction(
                      () => verifyWorkspaceAgentRuntimeProviderAction({
                        employeeName: selectedAgent.internalName,
                        runtimeId: selectedAgent.boundContainerId!,
                      }),
                      () => setProviderVerificationPendingRuntimeIds((current) =>
                        new Set([...current, selectedAgent.boundContainerId!]),
                      ),
                    );
                  }}
                  onDeleteAgent={() =>
                    runAction(
                      () => deleteWorkspaceAgentAction(selectedAgent.internalName),
                      () => setSelectedAgentId(null),
                    )
                  }
                  onStartConversation={() => {
                    const href = workspaceHref(`/im?view=direct&focus=${encodeURIComponent(`contact:${selectedAgent.internalName}`)}`);
                    if (!navigateWorkspaceModule(href)) {
                      router.push(href, { scroll: false });
                    }
                  }}
                  onSaveInstructions={(instructions) =>
                    runAction(
                      () =>
                        updateWorkspaceAgentInstructionsAction({
                          employeeName: selectedAgent.internalName,
                          instructions,
                        }),
                    )
                  }
                  onSaveDefaultModel={(defaultModel) =>
                    runAction(
                      () =>
                        updateWorkspaceAgentDefaultModelAction({
                          employeeName: selectedAgent.internalName,
                          defaultModel,
                        }),
                    )
                  }
                  onSetChannelMemberAccess={(channelMemberAccess) =>
                    runAction(
                      () =>
                        setWorkspaceAgentChannelMemberAccessAction({
                          employeeName: selectedAgent.internalName,
                          channelMemberAccess,
                        }),
                    )
                  }
                  onSetSkillIds={(skillIds) =>
                    runAction(
                      () =>
                        setWorkspaceAgentSkillAssignmentsAction({
                          employeeName: selectedAgent.internalName,
                          skillIds,
                        }),
                    )
                  }
                  onInstallSkill={(skillId, input) =>
                    runAction(
                      () => installWorkspaceAgentSkillAction({
                        employeeName: selectedAgent.internalName,
                        skillId,
                        ...input,
                      }),
                    )
                  }
                  onSetKnowledgePageIds={(knowledgePageIds) =>
                    runAction(
                      () =>
                        setWorkspaceAgentKnowledgeAssignmentsAction({
                          employeeName: selectedAgent.internalName,
                          knowledgePageIds,
                        }),
                    )
                  }
                  onCreateForkInvitation={(input) =>
                    runAction(
                      () =>
                        createAgentForkInvitationAction({
                          sourceAgentName: selectedAgent.internalName,
                          targetUserId: input.targetUserId,
                          options: input.options,
                        }),
                    )
                  }
                  onRevokeForkInvitation={(invitationId) =>
                    runAction(
                      () => revokeAgentForkInvitationAction({ invitationId }),
                    )
                  }
                  onFeishuAgentBotUpdated={() => refreshWorkspaceModule(onDataChanged, router)}
                />
              ) : (
                <EmptyState body={tx("先选择一个 AI员工，查看它的绑定、任务和工作区域。", "Select an AI employee to view bindings, tasks, and work areas.")} title={tx("未选择 AI员工", "No AI employee selected")} />
              )}
            </section>
          ) : null}
        </div>
      ) : mode === "showcase" ? (
        <div className="agents-shell agents-shell--showcase">
          <section className="page-panel agents-showcase-pane">
            <DigitalEmployeeShowcase
              agents={data.showcaseAgents}
              pending={isPending}
              tx={tx}
              onApproveRequest={(requestId) =>
                runAction(
                  () => approveAgentAccessRequestAction({ requestId }),
                )
              }
              onCancelRequest={(requestId) =>
                runAction(
                  () => cancelAgentAccessRequestAction({ requestId }),
                )
              }
              onOpenAgent={(agentName) => {
                setSelectedAgentId(`agent:${agentName}`);
                const href = workspaceHref(`/agents?mode=agent&focus=${encodeURIComponent(`agent:${agentName}`)}`);
                if (!navigateWorkspaceModule(href)) {
                  router.push(href, { scroll: false });
                }
              }}
              onOpenInvitationInbox={() => {
                const href = workspaceHref("/agents?mode=agent");
                if (!navigateWorkspaceModule(href)) {
                  router.push(href, { scroll: false });
                }
              }}
              onRejectRequest={(requestId) =>
                runAction(
                  () => rejectAgentAccessRequestAction({ requestId }),
                )
              }
              onRequestCopy={setRequestingShowcaseAgent}
            />
          </section>
        </div>
      ) : (
        <div
          className={`agents-shell agents-shell--container${isCompactLayout ? " agents-shell--compact" : ""}`}
          style={containerListPaneResize.paneStyle}
        >
          {showListPane ? (
            <aside className="page-panel agents-pane">
              <div className="panel-header agents-pane__list-header agents-pane__list-header--container">
                <div className="agents-pane__container-heading">
                  <h3 className="agents-pane__container-title">{tx("在线执行引擎", "Online execution engines")}</h3>
                  <div className="agents-pane__container-summary" aria-label={tx(`${serverCount} 台服务器，${data.daemonTokens.length} 个令牌`, `${serverCount} servers, ${data.daemonTokens.length} tokens`)}>
                    <span><strong>{serverCount}</strong>{tx("服务器", "servers")}</span>
                    <span><strong>{data.daemonTokens.length}</strong>{tx("令牌", "tokens")}</span>
                  </div>
                </div>
                <div className="agents-pane__container-actions">
                  {data.canConnectRuntimes ? (
                    <>
                      <button
                        aria-label={tx("接入服务器", "Connect server")}
                        aria-busy={isGeneratingContainerCommand}
                        className="action-button agents-pane__container-button"
                        disabled={isGeneratingContainerCommand}
                        onClick={handleCreateContainerCommand}
                        type="button"
                      >
                        {isGeneratingContainerCommand ? tx("生成中...", "Generating...") : tx("接入服务器", "Connect server")}
                      </button>
                      <div className="agents-pane__container-help">
                        <InlineHelpTooltip
                          label={tx("接入服务器说明", "Connect server help")}
                          tooltip={tx(
                            "接入服务器后会自动上报可用执行引擎。",
                            "Connected servers automatically report their available execution engines.",
                          )}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="agents-container-list">
                {data.canManageRuntimes ? (
                  <button
                    aria-pressed={isDaemonManagementSelected}
                    className={`agents-container-row agents-container-row--management${isDaemonManagementSelected ? " agents-container-row--active" : ""}`}
                    onClick={handleSelectDaemonManagement}
                    type="button"
                  >
                    <div className="agents-container-row__title">
                      <div className="agents-container-row__copy">
                        <strong>{tx("服务器管理", "Server Management")}</strong>
                        <span className="agents-container-row__management-copy">{tx("查看接入状态、运行时与令牌", "Review connections, runtimes, and tokens")}</span>
                      </div>
                      <div className="agents-container-row__management-stats" aria-label={tx(`${serverCount} 台服务器，${data.daemonTokens.length} 个令牌`, `${serverCount} servers, ${data.daemonTokens.length} tokens`)}>
                        <span><strong>{serverCount}</strong>{tx("服务器", "servers")}</span>
                        <span><strong>{data.daemonTokens.length}</strong>{tx("令牌", "tokens")}</span>
                      </div>
                    </div>
                  </button>
                ) : null}

                {data.containers.length > 0 ? (
                  runtimeServerGroups.map((group) => (
                    <section className="agents-runtime-server-group" key={group.id} aria-labelledby={`runtime-server-${group.id}`}>
                      <button
                        aria-controls={`runtime-server-runtimes-${group.id}`}
                        aria-expanded={expandedRuntimeServerIds.has(group.id)}
                        aria-label={expandedRuntimeServerIds.has(group.id)
                          ? tx(`收起 ${group.label} 的执行引擎`, `Collapse execution engines on ${group.label}`)
                          : tx(`展开 ${group.label} 的执行引擎`, `Expand execution engines on ${group.label}`)}
                        className="agents-runtime-server-group__header"
                        onClick={() => toggleRuntimeServerGroup(group.id)}
                        type="button"
                      >
                        <div className="agents-runtime-server-group__identity">
                          <span className={`agents-runtime-server-group__icon agents-runtime-server-group__icon--${group.mode}`}>
                            <AppIcon name="containers" />
                          </span>
                          <div>
                            <strong id={`runtime-server-${group.id}`}>{group.label}</strong>
                            <span>{formatRuntimeHostMode(group.mode, tx)}</span>
                          </div>
                        </div>
                        <span className="agents-runtime-server-group__count">
                          {tx(`${group.containers.length} 个引擎`, `${group.containers.length} engines`)}
                        </span>
                      </button>
                      {expandedRuntimeServerIds.has(group.id) ? (
                        <div className="agents-runtime-server-group__runtimes" id={`runtime-server-runtimes-${group.id}`}>
                          {group.containers.map((container) => (
                            <button
                              aria-label={tx(`${container.name}，${formatDaemonProviderLabel(container.provider)}`, `${container.name}, ${formatDaemonProviderLabel(container.provider)}`)}
                              aria-pressed={selectedContainerId === container.runtimeId}
                              className={`agents-container-row agents-container-row--runtime${selectedContainerId === container.runtimeId ? " agents-container-row--active" : ""}`}
                              key={container.id}
                              onClick={() => handleSelectContainer(container.runtimeId)}
                              type="button"
                            >
                              <div className="agents-container-row__title">
                                <div className="agents-container-row__copy">
                                  <strong>{formatDaemonProviderLabel(container.provider)}</strong>
                                  <div className="agents-container-row__remark">
                                    <span>
                                      {container.displayName
                                        ? tx(`备注名：${container.displayName}`, `Remark: ${container.displayName}`)
                                        : container.subtitle}
                                    </span>
                                  </div>
                                </div>
                                <div className="agents-container-row__state-actions">
                                  <span className={`status-chip status-chip--${toneForStatus(container.status)}`}>{translateManagementStatus(container.statusLabel, tx)}</span>
                                </div>
                              </div>
                              <div className="agents-container-row__meta">
                                <span>{container.displayName ? container.name : tx("未设置备注名", "No remark name")}</span>
                                <span>{tx(`${container.queueCounts.running} 运行中`, `${container.queueCounts.running} running`)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ))
                ) : (
                  <EmptyState body={tx("当前没有在线执行引擎。先接入一台服务器。", "There are no online execution engines. Connect a server first.")} title={tx("执行引擎为空", "No execution engines")} />
                )}
              </div>
            </aside>
          ) : null}

          {!isCompactLayout && showListPane && showDetailPane ? (
            <PaneResizeHandle
              label={tx("调整执行引擎列表宽度", "Resize execution engine list")}
              maxValue={containerListPaneResize.maxWidth}
              minValue={containerListPaneResize.minWidth}
              onKeyDown={containerListPaneResize.onHandleKeyDown}
              onPointerDown={containerListPaneResize.onHandlePointerDown}
              value={containerListPaneResize.width}
            />
          ) : null}

          {showDetailPane ? (
            <section className="page-panel agents-detail-pane">
              {isCompactLayout ? (
                <div className="agents-detail-pane__mobile-bar">
                  <button
                    aria-label={tx("返回列表", "Back to list")}
                    className="agents-detail-pane__back"
                  onClick={() => setMobilePane("list")}
                  type="button"
                >
                  <AppIcon name="arrowLeft" />
                </button>
                <div className="agents-detail-pane__mobile-copy">
                    <strong>{detailTitle}</strong>
                    <span>{isDaemonManagementSelected ? tx("服务器状态与令牌", "Server status and tokens") : tx("执行引擎详情", "Execution engine details")}</span>
                  </div>
                </div>
              ) : null}
              {isDaemonManagementSelected ? (
                data.canManageRuntimes ? (
                  <DaemonManagementPanel
                    daemonSnapshots={data.daemonSnapshots}
                    daemonTokens={data.daemonTokens}
                    providerAccounts={data.providerAccounts}
                    runtimeProvisionRequests={data.runtimeProvisionRequests}
                    pending={isPending}
                    onDeleteRuntime={(runtime) => handleDeleteRuntime(runtime.id, runtime.name)}
                  />
                ) : (
                  <EmptyState title={tx("无权限", "No access")} />
                )
              ) : (
                <ContainerOverview
                  container={selectedContainer}
                  containerCount={data.containerCount}
                  pending={isPending}
                  updating={isGeneratingContainerCommand}
                  selection={selectedContainerId}
                  workspaceMembers={data.workspaceMembers}
                  onGrantRuntime={(runtimeId, userId) =>
                    runAction(
                      () =>
                        grantWorkspaceRuntimeUseAction({
                          runtimeId,
                          userId,
                        }),
                    )
                  }
                  onRevokeRuntime={(runtimeId, userId) =>
                    runAction(
                      () =>
                        revokeWorkspaceRuntimeUseAction({
                          runtimeId,
                          userId,
                        }),
                    )
                  }
                  onUpdateRuntimeDisplayName={(runtimeId, displayName) =>
                    runAction(
                      () =>
                        updateWorkspaceRuntimeDisplayNameAction({
                          runtimeId,
                          displayName,
                        }),
                      )
                  }
                  onUpdateRuntime={data.canManageRuntimes
                    ? (container) => handleUpdateRuntimeCommand({
                        daemonKey: container.daemonKey,
                        runtimeId: container.runtimeId,
                        deviceName: container.deviceName,
                      })
                    : undefined}
                  onDeleteRuntime={data.canManageRuntimes ? handleDeleteRuntime : undefined}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

function buildCreateRuntimeCommand(input: {
  origin: string;
  daemonToken: string;
  daemonKey: string;
}): string {
  return [
    `bash <(curl -fsSL ${input.origin}/api/daemon/install-script) \\`,
    `  --server-url ${shellDoubleQuote(input.origin)} \\`,
    `  --daemon-token ${shellDoubleQuote(input.daemonToken)} \\`,
    `  --daemon-id ${shellDoubleQuote(input.daemonKey)}`,
  ].join("\n");
}

function buildUpdateRuntimeCommand(input: {
  origin: string;
  daemonToken: string;
  daemonKey: string;
  deviceName: string;
  runtimeName: string;
}): string {
  return [
    `bash <(curl -fsSL ${input.origin}/api/daemon/install-script) \\`,
    "  --update-existing \\",
    `  --server-url ${shellDoubleQuote(input.origin)} \\`,
    `  --daemon-token ${shellDoubleQuote(input.daemonToken)} \\`,
    `  --daemon-id ${shellDoubleQuote(input.daemonKey)} \\`,
    `  --device-name ${shellDoubleQuote(input.deviceName)} \\`,
    `  --runtime-name ${shellDoubleQuote(input.runtimeName)}`,
  ].join("\n");
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, (match) => `\\${match}`)}"`;
}

function groupContainersByServer(containers: AgentsPageData["containers"]): RuntimeServerGroup[] {
  const groups = new Map<string, RuntimeServerGroup>();

  for (const container of containers) {
    const mode = resolveRuntimeHostMode(container);
    const label = resolveRuntimeServerLabel(container, mode);
    const id = `${mode}-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown"}`;
    const group = groups.get(id);

    if (group) {
      group.containers.push(container);
      continue;
    }

    groups.set(id, {
      id,
      label,
      mode,
      containers: [container],
    });
  }

  return [...groups.values()];
}

function countDaemonServers(daemons: AgentsPageData["daemonSnapshots"]): number {
  return new Set(daemons.map((daemon) => {
    const mode = resolveRuntimeHostMode(daemon);
    return `${mode}:${resolveRuntimeServerLabel(daemon, mode).toLocaleLowerCase()}`;
  })).size;
}

function resolveRuntimeHostMode(runtime: {
  daemonKey: string;
  deviceName: string;
  daemonMode?: "local" | "remote";
  mode?: "local" | "remote";
  serverUrl?: string;
}): RuntimeHostMode {
  const identity = `${runtime.daemonKey} ${runtime.deviceName} ${runtime.serverUrl ?? ""}`.toLocaleLowerCase();

  if (/(^|[-_\s])(?:docker|container)(?:[-_\s]|$)/.test(identity)) {
    return "docker";
  }

  return runtime.daemonMode === "remote" || runtime.mode === "remote" ? "remote" : "local";
}

function resolveRuntimeServerLabel(
  runtime: {
    daemonKey: string;
    deviceName: string;
    serverUrl?: string;
  },
  mode: RuntimeHostMode,
): string {
  const daemonKeyAddress = runtime.daemonKey.match(/(?:^|[-_])((?:\d{1,3}[-.]){3}\d{1,3})(?:[-_]|$)/)?.[1];
  if (daemonKeyAddress) {
    return daemonKeyAddress.replace(/-/g, ".");
  }

  const deviceName = runtime.deviceName.trim();
  if (deviceName) {
    const withoutProvider = deviceName.replace(/\s+(?:claude(?:\s+code)?|codex|openclaw|opencode|hermes(?:\s+agent)?)$/i, "").trim();
    return withoutProvider || deviceName;
  }

  if (mode === "remote" && runtime.serverUrl) {
    try {
      return new URL(runtime.serverUrl).host;
    } catch {
      // A malformed server URL should not prevent the runtime list from rendering.
    }
  }

  return runtime.daemonKey || "Unknown server";
}

function formatRuntimeHostMode(mode: RuntimeHostMode, tx: (zh: string, en: string) => string): string {
  switch (mode) {
    case "docker":
      return tx("Docker 容器", "Docker container");
    case "remote":
      return tx("远程服务器", "Remote server");
    default:
      return tx("本地运行时", "Local runtime");
  }
}

function AgentForkInvitationInbox({
  containerOptions,
  drafts,
  invitations,
  pending,
  tx,
  onAccept,
  onDraftChange,
}: {
  readonly containerOptions: AgentsPageData["containerOptions"];
  readonly drafts: Record<string, { agentName: string; runtimeId: string }>;
  readonly invitations: WorkspaceAgentForkInvitationView[];
  readonly pending: boolean;
  readonly tx: (zh: string, en: string) => string;
  readonly onAccept: (invitationId: string) => void;
  readonly onDraftChange: (invitationId: string, draft: Partial<{ agentName: string; runtimeId: string }>) => void;
}) {
  return (
    <section className="agent-fork-inbox" aria-label={tx("待接受的 AI员工 复制邀请", "Pending AI employee copy invitations")}>
      <div className="agent-fork-inbox__header">
        <strong>{tx("待接受的 AI员工 复制邀请", "Pending AI employee copies")}</strong>
        <span>{invitations.length}</span>
      </div>
      <div className="agent-fork-inbox__list">
        {invitations.map((invitation) => {
          const draft = drafts[invitation.id] ?? { agentName: invitation.suggestedAgentName, runtimeId: containerOptions[0]?.id ?? "" };
          return (
            <article className="agent-fork-inbox__item" key={invitation.id}>
              <div className="agent-fork-inbox__copy">
                <strong>{invitation.sourceAgentDisplayName}</strong>
                <p>
                  {tx(
                    `${invitation.createdByDisplayName ?? "同事"} 邀请你复制这个 Agent。`,
                    `${invitation.createdByDisplayName ?? "A teammate"} invited you to copy this agent.`,
                  )}
                </p>
                {invitation.contextNote ? <span>{invitation.contextNote}</span> : null}
                <small>{formatForkScope(invitation, tx)}</small>
              </div>
              <label className="agent-fork-inbox__field">
                <span>{tx("新 AI员工 名称", "New AI employee name")}</span>
                <input
                  disabled={pending}
                  onChange={(event) => onDraftChange(invitation.id, { agentName: event.currentTarget.value })}
                  value={draft.agentName}
                />
              </label>
              <label className="agent-fork-inbox__field">
                <span>{tx("执行引擎", "Execution engine")}</span>
                <select
                  disabled={pending || containerOptions.length === 0}
                  onChange={(event) => onDraftChange(invitation.id, { runtimeId: event.currentTarget.value })}
                  value={draft.runtimeId}
                >
                  {containerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} · {formatDaemonProviderLabel(option.provider)}
                    </option>
                  ))}
                </select>
              </label>
              {containerOptions.length === 0 ? (
                <p className="agent-fork-inbox__empty-runtime">
                  {tx("请让管理员先分配执行引擎。", "Ask an admin to assign an execution engine first.")}
                </p>
              ) : null}
              <div className="agent-fork-inbox__actions">
                <button
                  className="primary-button"
                  disabled={pending || containerOptions.length === 0 || !draft.agentName.trim() || !draft.runtimeId}
                  onClick={() => onAccept(invitation.id)}
                  type="button"
                >
                  {tx("接受复制", "Accept copy")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatForkScope(
  invitation: WorkspaceAgentForkInvitationView,
  tx: (zh: string, en: string) => string,
): string {
  const scopes = [
    invitation.copyProfile ? tx("资料", "Profile") : "",
    invitation.copyInstructions ? tx("工作说明", "Instructions") : "",
    invitation.copySkills ? tx(`${invitation.copiedSkillCount} skills`, `${invitation.copiedSkillCount} skills`) : "",
    invitation.copyKnowledgeAssignments
      ? tx(`${invitation.copiedKnowledgePageCount} 知识`, `${invitation.copiedKnowledgePageCount} knowledge pages`)
      : "",
  ].filter(Boolean);
  return scopes.join(" · ");
}
