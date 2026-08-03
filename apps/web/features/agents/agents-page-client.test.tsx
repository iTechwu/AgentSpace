import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPageClient } from "@/features/agents/agents-page-client";
import { AgentDetail } from "@/features/agents/components/agent-detail";
import { SkillRequirementsModal } from "@/features/skills/components/skill-requirements-modal";
import { SkillPickerModal } from "@/features/agents/components/skill-picker-modal";
import { WorkspaceModuleNavigationProvider } from "@/features/dashboard/workspace-module-navigation";
import {
  approveAgentAccessRequestAction,
  cancelAgentAccessRequestAction,
  createContainerInstallTokenAction,
  createAgentAccessRequestAction,
  createWorkspaceAgentAction,
  deleteWorkspaceRuntimeAction,
  rejectAgentAccessRequestAction,
  pruneOldOfflineDaemonsAction,
  setWorkspaceAgentChannelMemberAccessAction,
  updateWorkspaceRuntimeDisplayNameAction,
  verifyWorkspaceAgentRuntimeProviderAction,
} from "@/features/agents/actions";
import {
  checkFeishuIntegrationHealthAction,
  createFeishuAgentBotBindingAction,
  rotateFeishuAgentBotCredentialsAction,
} from "@/features/integrations/feishu/feishu-actions";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import type { AgentsPageData } from "@/features/dashboard/data";

const searchParams = new URLSearchParams();
const mockRefresh = vi.fn();
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    replace: mockReplace,
  }),
  usePathname: () => "/w/workspace-alpha/agents",
  useSearchParams: () => ({
    get: (key: string) => searchParams.get(key),
  }),
}));

vi.mock("@/features/agents/actions", () => ({
  acceptAgentForkInvitationAction: vi.fn(async () => ({ data: undefined })),
  approveAgentAccessRequestAction: vi.fn(async () => ({ data: undefined })),
  bindWorkspaceAgentRuntimeAction: vi.fn(async () => {}),
  cancelAgentAccessRequestAction: vi.fn(async () => ({ data: undefined })),
  createContainerInstallTokenAction: vi.fn(async () => ({ id: "daemon-token-1", label: "container", token: "adt_test" })),
  createAgentAccessRequestAction: vi.fn(async () => ({ data: undefined })),
  createAgentForkInvitationAction: vi.fn(async () => ({ data: undefined })),
  createWorkspaceAgentAction: vi.fn(async () => {}),
  installWorkspaceAgentSkillAction: vi.fn(async () => ({ data: undefined })),
  createWorkspaceTaskAction: vi.fn(async () => {}),
  deleteWorkspaceAgentAction: vi.fn(async () => {}),
  deleteWorkspaceRuntimeAction: vi.fn(async () => {}),
  grantWorkspaceRuntimeUseAction: vi.fn(async () => {}),
  pruneOldOfflineDaemonsAction: vi.fn(async () => ({ data: { removedCount: 1 } })),
  rejectAgentAccessRequestAction: vi.fn(async () => ({ data: undefined })),
  revokeAgentForkInvitationAction: vi.fn(async () => ({ data: undefined })),
  revokeWorkspaceRuntimeUseAction: vi.fn(async () => {}),
  setWorkspaceAgentChannelMemberAccessAction: vi.fn(async () => {}),
  setWorkspaceAgentKnowledgeAssignmentsAction: vi.fn(async () => ({ data: undefined })),
  setWorkspaceAgentSkillAssignmentsAction: vi.fn(async () => {}),
  unbindWorkspaceAgentRuntimeAction: vi.fn(async () => {}),
  updateWorkspaceAgentInstructionsAction: vi.fn(async () => {}),
  updateWorkspaceRuntimeDisplayNameAction: vi.fn(async () => {}),
  verifyWorkspaceAgentRuntimeProviderAction: vi.fn(async () => ({ data: undefined })),
}));

vi.mock("@/features/settings/actions", () => ({
  createDaemonApiTokenAction: vi.fn(async () => ({
    data: {
      id: "daemon-token-2",
      label: "build-box-1",
      token: "adt_secret_value",
    },
  })),
  revokeDaemonApiTokenAction: vi.fn(async () => {}),
}));

vi.mock("@/features/integrations/feishu/feishu-actions", () => ({
  checkFeishuIntegrationHealthAction: vi.fn(async () => ({
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "active",
    transportMode: "websocket_worker",
    agentId: "planner",
    appId: "cli_planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    lastHealthStatus: "healthy",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 1,
    channelBindingCount: 2,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
  })),
  createFeishuAgentBotBindingAction: vi.fn(async () => ({
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "active",
    transportMode: "websocket_worker",
    agentId: "planner",
    appId: "cli_planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 0,
    channelBindingCount: 0,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
  })),
  disableFeishuAgentBotBindingAction: vi.fn(async () => ({
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "disabled",
    transportMode: "websocket_worker",
    agentId: "planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 0,
    channelBindingCount: 0,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
  })),
  inspectFeishuAgentBotBindingAvailabilityAction: vi.fn(async () => ({
    state: "available",
  })),
  rotateFeishuAgentBotCredentialsAction: vi.fn(async () => ({
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "active",
    transportMode: "websocket_worker",
    agentId: "planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 0,
    channelBindingCount: 0,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
  })),
  updateFeishuAgentBotPolicyAction: vi.fn(async () => ({
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "active",
    transportMode: "websocket_worker",
    agentId: "planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 0,
    channelBindingCount: 0,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
  })),
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const data: AgentsPageData = {
  containers: [
    {
      id: "container-1",
      kind: "container",
      name: "Local Runtime",
      subtitle: "Codex runtime",
      description: "Connected runtime",
      status: "linked",
      statusLabel: "在线",
      tags: [],
      runtimeId: "runtime-1",
      provider: "codex",
      daemonKey: "daemon-1",
      deviceName: "MacBook",
      version: "1.0.0",
      lastHeartbeatAt: "2026-04-10T09:00:00.000Z",
      runtimeStatus: "online",
      providerHealth: {
        runtimeStatus: "online",
        providerHealth: "healthy",
        providerUsable: "usable",
      },
      grantedMembers: [],
      canManageGrants: true,
      boundEmployees: ["planner"],
      agentCount: 1,
      queueCounts: {
        queued: 0,
        running: 1,
        failed: 0,
        completed: 2,
      },
      installedApps: [],
      recentAppOperations: [],
      recentExecutions: [],
    },
  ],
  agents: [
    {
      id: "agent:planner",
      employeeId: "emp-planner",
      kind: "agent",
      name: "Planner",
      subtitle: "Travel planner",
      description: "Plans itineraries",
      status: "linked",
      statusLabel: "在线",
      tags: [],
      internalName: "planner",
      origin: "workspace",
      canManage: true,
      canManageChannelMemberAccess: true,
      channelMemberAccess: "enabled",
      fit: "Great for planning",
      summary: "Plans itineraries and travel docs",
      skills: [],
      skillRequirements: {},
      channels: ["travel"],
      tasks: [],
      recentMessages: [],
      boundContainerId: "runtime-1",
      boundContainerName: "Local Runtime",
      boundContainerStatus: "online",
      boundProvider: "codex",
      boundProviderHealth: {
        runtimeStatus: "online",
        providerHealth: "healthy",
        providerUsable: "usable",
      },
      boundAt: "2026-04-10T08:00:00.000Z",
      workAreas: [
        {
          id: "group:travel:planner",
          queueId: "group:travel:planner",
          title: "travel",
          channel: "travel",
          queueStatus: "completed",
          updatedAt: "2026-04-10 10:00",
          sessionId: "sess-1",
          workDir: "/tmp/travel-workspace",
          workDirAccess: "remote",
          workDirHostLabel: "Build Box 1",
          errorText: "上一次执行失败",
        },
      ],
      instructions: "Keep plans concise.",
      knowledge: {
        directPageIds: ["knowledge-planner-playbook"],
        inheritedPages: [
          {
            id: "knowledge-shared-handbook",
            title: "Shared handbook",
            tags: ["shared"],
            updatedAt: "2026-04-10T08:00:00.000Z",
            assignmentMode: "all_agents",
          },
        ],
        directPages: [
          {
            id: "knowledge-planner-playbook",
            title: "Planner playbook",
            tags: ["planning"],
            updatedAt: "2026-04-10T08:00:00.000Z",
            assignmentMode: "selected_agents",
          },
        ],
        assignablePages: [
          {
            id: "knowledge-legal-memo",
            title: "Legal memo",
            tags: ["legal"],
            updatedAt: "2026-04-10T08:00:00.000Z",
            assignmentMode: "selected_agents",
          },
        ],
        totalAvailableCount: 2,
        directCount: 1,
        inheritedCount: 1,
      },
      documentAccess: {
        readableCount: 1,
        editableCount: 1,
        forwardableCount: 1,
        externalCount: 1,
        pendingRequestCount: 1,
        rejectedRequestCount: 0,
        grants: [
          {
            id: "grant-1",
            documentId: "doc-1",
            documentTitle: "Travel budget",
            channelName: "travel",
            role: "forwarder",
            source: "explicit_grant",
            storageMode: "external",
            externalProvider: "notion",
            externalFileId: "page-1",
            externalUrl: "https://www.notion.so/page-1",
            updatedAt: "2026-04-10T08:00:00.000Z",
          },
        ],
        requests: [
          {
            id: "request-1",
            status: "pending",
            requestedRole: "editor",
            targetLabel: "Vendor notes",
            requestedForChannelName: "travel",
            reason: "Need to update the shared vendor notes.",
            createdAt: "2026-04-10T08:00:00.000Z",
          },
        ],
      },
      feishuAgentBotSetupReference: {
        requiredCredentialFields: ["app_id", "app_secret"],
        requiredEvents: ["im.message.receive_v1", "im.chat.member.bot.added_v1", "card.action.trigger"],
        requiredScopes: [
          "im:message",
          "im:message:send_as_bot",
          "contact:contact.base:readonly",
          "docx:document",
          "drive:drive",
          "sheets:spreadsheet",
          "bitable:app",
        ],
        eventCallbackPath: "/api/integrations/feishu/events",
        developerConsoleUrl: "https://open.feishu.cn/app",
        openPlatformSetupSteps: [],
      },
    },
  ],
  showcaseAgents: [
    {
      id: "agent:designer",
      kind: "digital_employee_showcase_agent",
      name: "Design Partner",
      subtitle: "Digital employee",
      description: "Shapes product concepts",
      status: "linked",
      statusLabel: "在线",
      tags: ["product"],
      internalName: "designer",
      role: "Product Designer",
      summary: "Helps turn product ideas into reviewable interface plans.",
      fit: "Design exploration",
      traits: ["界面设计", "评审材料"],
      ownerUserId: "user-designer-owner",
      ownerDisplayName: "Dana",
      managedByLabel: "Dana 管理",
      canManage: false,
      isOwnedByCurrentUser: false,
      channelMemberAccess: "enabled",
      channels: ["travel"],
      commonChannels: ["travel"],
      skillCount: 2,
      knowledgeCount: 1,
      skillHighlights: [
        { name: "interface-review", summary: "Review product UI flows" },
        { name: "brief-writing", summary: "Prepare design briefs" },
      ],
      knowledgeHighlights: [
        { title: "Design handbook", source: "direct" },
      ],
      readiness: {
        status: "ready",
        label: "可用",
        reason: "codex · Local Runtime",
      },
      usageHints: ["可在共同频道调用：travel", "2 个技能", "1 份知识"],
      lastActivityAt: "2026-04-10T09:30:00.000Z",
      requestableActions: ["fork_copy"],
      reviewableRequests: [],
    },
  ],
  daemonSnapshots: [
    {
      daemonKey: "daemon-1",
      deviceName: "Build Box 1",
      status: "online",
      lastHeartbeatAt: "2026-04-10T09:00:00.000Z",
      mode: "remote",
      serverUrl: "https://daemon.example.com",
      runtimeName: "Remote Agent",
      runtimes: [
        {
          id: "runtime-1",
          provider: "codex",
          name: "Remote Codex",
          status: "online",
          lastHeartbeatAt: "2026-04-10T09:00:00.000Z",
          version: "1.0.0",
          providerHealth: {
            runtimeStatus: "online",
            providerHealth: "healthy",
            providerUsable: "usable",
          },
        },
      ],
    },
  ],
  daemonTokens: [
    {
      id: "daemon-token-1",
      label: "build-box-1",
      status: "active",
      createdBy: "techwu",
      lastUsedAt: "2026-04-10T09:00:00.000Z",
      createdAt: "2026-04-10T08:00:00.000Z",
    },
  ],
  providerAccounts: [],
  runtimeProvisionRequests: [],
  workspaceSkills: [],
  workspaceMembers: [],
  pendingForkInvitations: [],
  channels: [
    {
      name: "travel",
      memberLabel: "1 人类 / 1 agent",
    },
  ],
  containerOptions: [
    {
      id: "runtime-1",
      label: "Local Runtime",
      provider: "codex",
      status: "online",
      serverName: "MacBook",
      daemonKey: "daemon-1",
      mode: "remote",
      providerHealth: {
        runtimeStatus: "online",
        providerHealth: "healthy",
        providerUsable: "usable",
      },
    },
  ],
  canManageRuntimes: true,
  canConnectRuntimes: true,
  canManageAllAgents: true,
  canCreateAgent: true,
  totalAgents: 1,
  containerCount: 1,
  boundAgentCount: 1,
  unboundAgentCount: 0,
  activeTaskCount: 0,
  activeWorkAreaCount: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

function renderAgentsPage(
  pageData: AgentsPageData = data,
  props?: {
    onDataChanged?: () => void;
    onInvalidation?: AgentsPageClientProps["onInvalidation"];
    navigateWorkspaceModule?: (href: string, options?: { replace?: boolean }) => boolean;
  },
) {
  const content = (
    <AgentsPageClient
      data={pageData}
      onDataChanged={props?.onDataChanged}
      onInvalidation={props?.onInvalidation}
    />
  );

  return render(
    <LanguageProvider initialLanguage="zh">
      <FeedbackToastProvider>
        {props?.navigateWorkspaceModule ? (
          <WorkspaceModuleNavigationProvider navigateWorkspaceModule={props.navigateWorkspaceModule}>
            {content}
          </WorkspaceModuleNavigationProvider>
        ) : content}
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

type AgentsPageClientProps = ComponentProps<typeof AgentsPageClient>;

function buildAgentFeishuBot(
  overrides: Partial<NonNullable<AgentsPageData["agents"][number]["feishuAgentBot"]>> = {},
): NonNullable<AgentsPageData["agents"][number]["feishuAgentBot"]> {
  return {
    id: "feishu-agent-bot-planner",
    displayName: "Planner Feishu Bot",
    status: "active",
    transportMode: "websocket_worker",
    agentId: "planner",
    appId: "cli_planner",
    callbackUrl: "",
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
    lastHealthStatus: "healthy",
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
    userBindingCount: 1,
    channelBindingCount: 2,
    resourceBindingCount: 0,
    operationRunCount: 0,
    outboxFailureCount: 0,
    userBindings: [],
    channelBindings: [],
    resourceBindings: [],
    operationRuns: [],
    recentOutboxFailures: [],
    recentInboundEvents: [],
    channelAutoProvisioning: {
      botAdded: "auto_create_channel",
      firstMessage: "auto_create_if_bot_mentioned",
      reviewStatus: "approved",
    },
    externalGuestPolicy: {
      unboundUserMode: "reply_on_mention",
      guestPermissionProfile: "channel_context_only",
      requireIdentityFor: ["writes", "approvals", "private_resources", "runtime_sensitive_tools"],
    },
    setupGuide: {
      requiredCredentialFields: ["app_id", "app_secret"],
      requiredEvents: ["im.message.receive_v1", "im.chat.member.bot.added_v1", "card.action.trigger"],
      requiredScopes: ["im:message"],
      eventCallbackPath: "/api/integrations/feishu/events",
      developerConsoleUrl: "https://open.feishu.cn/app",
      openPlatformSetupSteps: [],
      checks: [],
      evidenceGates: [],
      commands: {
        healthCheck: "dofe-agent integrations feishu health-check --workspace-id workspace-1 --agent planner --strict --json",
        bindSecondAgentBot: "dofe-agent integrations feishu bind-agent-bot --workspace-id workspace-1 --agent CHANGE_ME_SECOND_AGENT_NAME --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --json",
        botReadiness: "dofe-agent integrations feishu agent-bot-readiness --workspace-id workspace-1 --agent planner --strict --require bot --json",
        dataPlaneReadiness: "dofe-agent integrations feishu agent-bot-readiness --workspace-id workspace-1 --agent planner --strict --require data-plane --json",
        workerReadiness: "dofe-agent integrations feishu agent-bot-readiness --workspace-id workspace-1 --agent planner --strict --require worker --json",
        autoProvisionPolicy: "dofe-agent integrations feishu auto-provision-policy --workspace-id workspace-1 --agent planner --bot-added-policy auto_create_channel --first-message-policy auto_create_if_bot_mentioned --unbound-user-mode reply_on_mention --guest-permission-profile channel_context_only --json",
        agentChannelAccessDisable: "dofe-agent integrations feishu agent-channel-access --workspace-id workspace-1 --agent planner --access disabled --json",
        agentChannelAccessRestore: "dofe-agent integrations feishu agent-channel-access --workspace-id workspace-1 --agent planner --access enabled --json",
        channelBindings: "dofe-agent integrations feishu channel-bindings --workspace-id workspace-1 --integration feishu-agent-bot-planner --json",
        smokeEnv: "dofe-agent integrations feishu smoke-env --workspace-id workspace-1 --integration feishu-agent-bot-planner --app-url https://agent.test > scripts/feishu/.env",
        checkEnv: "pnpm run smoke:feishu -- --env-file scripts/feishu/.env --check-env --json --require-todo120-native",
        strictLiveSmoke: "pnpm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --evidence runtime-output/feishu-smoke/live.json --json --require-todo120-native",
        verifyOpenApiEvidence: "pnpm run smoke:feishu -- --verify-evidence runtime-output/feishu-smoke/live.json --json",
        verifyBotAddedPayload: "pnpm run smoke:feishu -- --verify-bot-added-payload runtime-output/feishu-smoke/bot-added-callback.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --json",
        smokePlan: "dofe-agent integrations feishu smoke-plan --workspace-id workspace-1 --integration feishu-agent-bot-planner --app-url https://agent.test",
        evidence: "dofe-agent integrations feishu evidence --workspace-id workspace-1 --integration feishu-agent-bot-planner --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all",
      },
    },
    ...overrides,
  };
}

describe("AgentsPageClient", () => {
  beforeEach(() => {
    Array.from(searchParams.keys()).forEach((key) => searchParams.delete(key));
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.mocked(createWorkspaceAgentAction).mockResolvedValue({ data: undefined });
    vi.mocked(createAgentAccessRequestAction).mockResolvedValue({ data: undefined });
    vi.mocked(approveAgentAccessRequestAction).mockResolvedValue({ data: undefined });
    vi.mocked(cancelAgentAccessRequestAction).mockResolvedValue({ data: undefined });
    vi.mocked(rejectAgentAccessRequestAction).mockResolvedValue({ data: undefined });
    vi.mocked(deleteWorkspaceRuntimeAction).mockResolvedValue({ data: undefined });
    vi.mocked(updateWorkspaceRuntimeDisplayNameAction).mockResolvedValue({ data: undefined });
    mockMatchMedia(false);
    mockRefresh.mockReset();
    mockReplace.mockReset();
    vi.useRealTimers();
  });

  it("switches between agent list and detail on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    renderAgentsPage();

    expect(screen.getByRole("button", { name: /Planner/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
    expect(screen.queryByText("保存工作说明")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Planner/i }));

    expect(await screen.findByRole("button", { name: "返回列表" })).toBeInTheDocument();
    expect(screen.getByText("AI员工 详情")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑工作说明" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存工作说明" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑工作说明" }));
    expect(screen.getByRole("button", { name: "保存工作说明" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.getByText("执行工作区")).toBeInTheDocument();
    expect(screen.getByText(/可复用会话: sess-1/)).toBeInTheDocument();
    expect(screen.getByText(/远程执行工作区: Build Box 1/)).toBeInTheDocument();
    expect(screen.getByText("上一次执行失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回列表" }));

    expect(screen.getByRole("button", { name: /Planner/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
  });

  it("restores the selected employee from the URL after a page refresh", async () => {
    const user = userEvent.setup();
    const navigateWorkspaceModule = vi.fn((href: string) => {
      window.history.replaceState(window.history.state, "", href);
      return true;
    });
    const secondAgent = {
      ...data.agents[0]!,
      id: "agent:designer",
      internalName: "designer",
      name: "Designer",
    };
    const pageData = {
      ...data,
      agents: [data.agents[0]!, secondAgent],
      totalAgents: 2,
    };

    window.history.replaceState(window.history.state, "", "/w/workspace-alpha/agents?mode=agent");
    const view = renderAgentsPage(pageData, { navigateWorkspaceModule });
    const secondAgentButton = screen.getByRole("button", { name: /Designer/i });

    await user.click(secondAgentButton);

    expect(secondAgentButton).toHaveClass("agent-contact-row--active");
    expect(new URL(window.location.href).searchParams.get("focus")).toBe("agent:designer");
    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      "/w/workspace-alpha/agents?mode=agent&focus=agent%3Adesigner",
      { replace: true },
    );

    view.unmount();
    searchParams.set("focus", "agent:designer");
    renderAgentsPage(pageData);

    expect(screen.getByRole("button", { name: /Designer/i })).toHaveClass("agent-contact-row--active");
    window.history.replaceState(window.history.state, "", "/w/workspace-alpha/agents");
  });

  it("restores the selected employee detail tab from the URL after a page refresh", async () => {
    const user = userEvent.setup();
    const navigateWorkspaceModule = vi.fn((href: string) => {
      window.history.replaceState(window.history.state, "", href);
      return true;
    });

    window.history.replaceState(window.history.state, "", "/w/workspace-alpha/agents?mode=agent&focus=agent%3Aplanner");
    const view = renderAgentsPage(data, { navigateWorkspaceModule });

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      "/w/workspace-alpha/agents?mode=agent&focus=agent%3Aplanner&tab=settings",
      { replace: true },
    );

    view.unmount();
    searchParams.set("focus", "agent:planner");
    searchParams.set("tab", "settings");
    renderAgentsPage(data);

    expect(screen.getByRole("button", { name: "设置" })).toHaveClass("agent-tab--active");
    expect(screen.getByText("Feishu Bot")).toBeInTheDocument();
    window.history.replaceState(window.history.state, "", "/w/workspace-alpha/agents");
  });

  it("renders a help hint beside the new agent action", async () => {
    const user = userEvent.setup();

    renderAgentsPage();

    const helpButton = screen.getByRole("button", { name: "新建 AI员工 说明" });
    expect(screen.getByRole("button", { name: "新建 AI员工" })).toBeInTheDocument();
    expect(helpButton).toBeInTheDocument();
    await user.hover(helpButton);
    expect(await screen.findByText("AI员工 可先创建，后续再绑定执行引擎和 skills。")).toBeInTheDocument();
  });

  it("uses semantic colors for employee statuses in the directory", () => {
    const agentsWithStatuses: AgentsPageData = {
      ...data,
      agents: [
        { ...data.agents[0]!, status: "online", statusLabel: "online" },
        { ...data.agents[0]!, id: "agent:working", name: "处理中员工", internalName: "working", status: "busy", statusLabel: "busy" },
        { ...data.agents[0]!, id: "agent:blocked", name: "异常员工", internalName: "blocked", status: "blocked", statusLabel: "blocked" },
      ],
    };

    renderAgentsPage(agentsWithStatuses);

    const directoryStatus = (label: string) => screen.getAllByText(label).find((element) => element.classList.contains("agent-contact-status"));
    expect(directoryStatus("在线")).toHaveClass("agent-contact-status--positive");
    expect(directoryStatus("处理中")).toHaveClass("agent-contact-status--warning");
    expect(directoryStatus("阻塞")).toHaveClass("agent-contact-status--danger");
  });

  it("opens the new agent flow from a directory create deep link", async () => {
    searchParams.set("mode", "agent");
    searchParams.set("create", "agent");

    renderAgentsPage();

    expect(await screen.findByRole("button", { name: "执行引擎" })).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith("/w/workspace-alpha/agents?mode=agent", { scroll: false });
  });

  it("shows agent knowledge assignments", async () => {
    const user = userEvent.setup();

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "知识" }));
    expect(screen.getByText("Shared handbook")).toBeInTheDocument();
    expect(screen.getByText("Planner playbook")).toBeInTheDocument();
  });

  it("opens the employee conversation from the empty workspace guide", async () => {
    const user = userEvent.setup();
    const navigateWorkspaceModule = vi.fn(() => true);
    const selectedAgent = data.agents[0]!;
    const dataWithoutWorkspaces: AgentsPageData = {
      ...data,
      agents: data.agents.map((agent) => agent.id === selectedAgent.id ? { ...agent, workAreas: [] } : agent),
    };

    renderAgentsPage(dataWithoutWorkspaces, { navigateWorkspaceModule });

    await user.click(screen.getByRole("button", { name: "工作区" }));
    await user.click(screen.getByRole("button", { name: "开始对话" }));

    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      `/w/workspace-alpha/im?view=direct&focus=${encodeURIComponent(`contact:${selectedAgent.internalName}`)}`,
    );
  });

  it("opens knowledge creation and group documents from empty resource guides", async () => {
    const user = userEvent.setup();
    const navigateWorkspaceModule = vi.fn(() => true);
    const selectedAgent = data.agents[0]!;
    const dataWithoutResources: AgentsPageData = {
      ...data,
      agents: data.agents.map((agent) => agent.id === selectedAgent.id ? {
        ...agent,
        knowledge: {
          ...agent.knowledge!,
          directPageIds: [],
          directPages: [],
          inheritedPages: [],
          assignablePages: [],
          totalAvailableCount: 0,
          directCount: 0,
          inheritedCount: 0,
        },
        documentAccess: {
          ...agent.documentAccess!,
          grants: [],
          requests: [],
          readableCount: 0,
          editableCount: 0,
          forwardableCount: 0,
          externalCount: 0,
          pendingRequestCount: 0,
          rejectedRequestCount: 0,
        },
      } : agent),
    };

    renderAgentsPage(dataWithoutResources, { navigateWorkspaceModule });

    await user.click(screen.getByRole("button", { name: "知识" }));
    await user.click(screen.getAllByRole("button", { name: "新建知识" }).at(-1)!);
    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      `/w/workspace-alpha/knowledge?create=page&assign=${encodeURIComponent(selectedAgent.internalName)}`,
    );

    await user.click(screen.getByRole("button", { name: "文档权限" }));
    await user.click(screen.getByRole("button", { name: "打开群文档" }));
    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      `/w/workspace-alpha/im?focus=${encodeURIComponent(`channel:${selectedAgent.channels[0]}`)}&tab=documents`,
    );
  });

  it("shows agent document access and permission requests", async () => {
    const user = userEvent.setup();

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "文档权限" }));

    expect(screen.getByText("Travel budget")).toBeInTheDocument();
    expect(screen.getByText("Vendor notes")).toBeInTheDocument();
    expect(screen.getByText("Need to update the shared vendor notes.")).toBeInTheDocument();
    expect(screen.getAllByText("可转发").length).toBeGreaterThan(0);
    expect(screen.getByText("待审批")).toBeInTheDocument();
  });

  it("requests a copy from the digital employee showcase", async () => {
    searchParams.set("mode", "showcase");
    const user = userEvent.setup();

    renderAgentsPage();

    expect(screen.getByRole("heading", { name: "数字员工展板" })).toBeInTheDocument();
    expect(screen.getByText("Design Partner")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "申请复制给我" }));
    await user.type(screen.getByLabelText("申请说明"), "用于整理旅行产品的评审材料");
    await user.click(screen.getByRole("button", { name: "发送申请" }));

    await waitFor(() => {
      expect(createAgentAccessRequestAction).toHaveBeenCalledWith({
        sourceAgentName: "designer",
        requestType: "fork_copy",
        targetChannelName: undefined,
        reason: "用于整理旅行产品的评审材料",
      });
    });
  });

  it("requests channel use from the digital employee showcase", async () => {
    searchParams.set("mode", "showcase");
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      showcaseAgents: [
        {
          ...data.showcaseAgents[0]!,
          channelMemberAccess: "disabled",
          requestableActions: ["fork_copy", "channel_use"],
          usageHints: ["可申请在共同频道使用：travel", "2 个技能", "1 份知识"],
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "申请使用权限" }));
    await user.click(screen.getByRole("radio", { name: /在频道使用/ }));
    await user.type(screen.getByLabelText("申请说明"), "希望在旅行频道里调用它整理设计反馈");
    await user.click(screen.getByRole("button", { name: "发送申请" }));

    await waitFor(() => {
      expect(createAgentAccessRequestAction).toHaveBeenCalledWith({
        sourceAgentName: "designer",
        requestType: "channel_use",
        targetChannelName: "travel",
        reason: "希望在旅行频道里调用它整理设计反馈",
      });
    });
  });

  it("shows a review queue on the digital employee showcase", async () => {
    searchParams.set("mode", "showcase");
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      showcaseAgents: [
        {
          ...data.showcaseAgents[0]!,
          reviewableRequests: [
            {
              id: "agent-access-request-1",
              sourceAgentName: "designer",
              requesterUserId: "user-requester",
              requesterDisplayName: "Mina",
              requestType: "channel_use",
              targetChannelName: "travel",
              status: "pending",
              reason: "Use it for design review in the travel channel.",
              createdAt: "2026-04-10T09:00:00.000Z",
              updatedAt: "2026-04-10T09:00:00.000Z",
              canDecide: true,
            },
          ],
        },
      ],
    });

    expect(screen.getByLabelText("待我审批")).toBeInTheDocument();
    expect(screen.getByText("Use it for design review in the travel channel.")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "批准" })[0]!);

    await waitFor(() => {
      expect(approveAgentAccessRequestAction).toHaveBeenCalledWith({
        requestId: "agent-access-request-1",
      });
    });
  });

  it("shows provider usability in agent settings", async () => {
    const user = userEvent.setup();
    const brokenData: AgentsPageData = {
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          boundProviderHealth: {
            runtimeStatus: "online",
            providerHealth: "broken",
            providerUsable: "unusable",
            providerHealthReason: "Authentication failed.",
            lastProviderErrorCode: "provider.auth_invalid",
            lastProviderErrorMessage: "Token expired.",
          },
        },
      ],
    };

    renderAgentsPage(brokenData);

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByText("Provider 状态")).toBeInTheDocument();
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(0);
    expect(screen.getByText(/provider.auth_invalid/)).toBeInTheDocument();
  });

  it("requests provider verification from the bound execution engine", async () => {
    const user = userEvent.setup();
    searchParams.set("tab", "settings");
    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          boundProviderHealth: undefined,
        },
      ],
    });

    expect(screen.getByText("点击上方按钮执行本机 CLI 预检。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "验证 Provider" }));

    await waitFor(() => {
      expect(verifyWorkspaceAgentRuntimeProviderAction).toHaveBeenCalledWith({
        employeeName: "planner",
        runtimeId: "runtime-1",
      });
    });
    expect(screen.getAllByText("验证中")).toHaveLength(2);
    expect(screen.getByText("正在等待执行引擎回传验证结果。")).toBeInTheDocument();
  });

  it("keeps runtime binding controls isolated while provider verification is pending", async () => {
    const user = userEvent.setup();
    let finishVerification!: (result: { data: undefined }) => void;
    const verificationRequest = new Promise<{ data: undefined }>((resolve) => {
      finishVerification = resolve;
    });
    vi.mocked(verifyWorkspaceAgentRuntimeProviderAction).mockReturnValueOnce(verificationRequest);
    searchParams.set("tab", "settings");

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          boundProviderHealth: undefined,
        },
      ],
    });

    const selectedEngineText = screen.getByRole("button", { name: "选择执行引擎" }).textContent;
    await user.click(screen.getByRole("button", { name: "验证 Provider" }));

    await waitFor(() => {
      expect(verifyWorkspaceAgentRuntimeProviderAction).toHaveBeenCalledWith({
        employeeName: "planner",
        runtimeId: "runtime-1",
      });
    });
    expect(screen.getByRole("button", { name: "验证中..." })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "更新中..." })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "绑定执行引擎" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择执行引擎" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "解除绑定" })).toBeDisabled();

    await act(async () => {
      finishVerification({ data: undefined });
      await verificationRequest;
    });

    expect(screen.getByRole("button", { name: "绑定执行引擎" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择执行引擎" })).toHaveTextContent(selectedEngineText ?? "");
  });

  it("shows an agent-scoped Feishu bot in agent settings", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          feishuAgentBot: buildAgentFeishuBot(),
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByText("Feishu Bot")).toBeInTheDocument();
    expect(screen.getByText("Planner Feishu Bot")).toBeInTheDocument();
    expect(screen.getByText("健康")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu health-check --workspace-id workspace-1 --agent planner --strict --json")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu bind-agent-bot --workspace-id workspace-1 --agent CHANGE_ME_SECOND_AGENT_NAME --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --json")).toBeInTheDocument();
    expect(screen.getByText("先在 scripts/feishu/.env 填入第二个飞书 app 凭据，再运行此命令创建第二个 Bot 绑定；通过 Phase 6 前置检查前，最终 evidence --require all 会保持 blocked。")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu agent-channel-access --workspace-id workspace-1 --agent planner --access disabled --json")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu agent-channel-access --workspace-id workspace-1 --agent planner --access enabled --json")).toBeInTheDocument();
    expect(screen.getByText("pnpm run smoke:feishu -- --env-file scripts/feishu/.env --check-env --json --require-todo120-native")).toBeInTheDocument();
    expect(screen.getByText("pnpm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --evidence runtime-output/feishu-smoke/live.json --json --require-todo120-native")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu smoke-plan --workspace-id workspace-1 --integration feishu-agent-bot-planner --app-url https://agent.test")).toBeInTheDocument();
    expect(screen.getByText("dofe-agent integrations feishu evidence --workspace-id workspace-1 --integration feishu-agent-bot-planner --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all")).toBeInTheDocument();
    expect(screen.getByText("im.chat.member.bot.added_v1")).toBeInTheDocument();
    expect(screen.getByText("im:message")).toBeInTheDocument();
    expect(screen.getByText("调整治理策略")).toBeInTheDocument();
  });

  it("checks an agent-scoped Feishu bot connection from its health card", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          feishuAgentBot: buildAgentFeishuBot({ lastHealthStatus: undefined }),
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "检查连接" }));

    await waitFor(() => {
      expect(checkFeishuIntegrationHealthAction).toHaveBeenCalledWith("feishu-agent-bot-planner");
    });
    expect(screen.getByText("飞书 Bot 连接检查通过。")).toBeInTheDocument();
  });

  it("keeps Feishu bot health check failures inside the health card", async () => {
    const user = userEvent.setup();
    vi.mocked(checkFeishuIntegrationHealthAction).mockResolvedValueOnce({
      ...buildAgentFeishuBot({ lastHealthStatus: "error" }),
    });

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          feishuAgentBot: buildAgentFeishuBot({ lastHealthStatus: undefined }),
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "检查连接" }));

    const feedback = await screen.findByText("飞书 Bot 连接检查失败。");
    const healthCard = feedback.closest(".feishu-agent-settings-panel__health");
    expect(healthCard).toHaveClass("feishu-agent-settings-panel__health--error");
    expect(healthCard).toContainElement(screen.getByText("异常"));
  });

  it("binds a Feishu bot from agent settings with only App ID and App Secret", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByLabelText("App ID")).toBeVisible();
    expect(screen.getByLabelText("App Secret")).toBeVisible();
    expect(screen.getByText("自定义高级功能").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("连接方式")).not.toBeVisible();
    expect(screen.getByLabelText("Tenant Key")).not.toBeVisible();
    expect(screen.getByText("im.chat.member.bot.added_v1")).not.toBeVisible();
    expect(screen.getByText("sheets:spreadsheet")).not.toBeVisible();
    await user.type(screen.getByLabelText("App ID"), "cli_planner");
    await user.type(screen.getByLabelText("App Secret"), "secret_planner");
    await user.click(screen.getByRole("button", { name: "绑定 Bot 并启用工作区" }));

    await waitFor(() => {
      expect(createFeishuAgentBotBindingAction).toHaveBeenCalledWith({
        agentId: "planner",
        displayName: "",
        transportMode: "websocket_worker",
        appId: "cli_planner",
        appSecret: "secret_planner",
        verificationToken: "",
        encryptKey: "",
        tenantKey: "",
        transferDisabledBindingId: undefined,
        channelAutoProvisioning: {
          botAdded: "auto_create_channel",
          firstMessage: "auto_create_if_bot_mentioned",
          reviewStatus: "approved",
        },
        externalGuestPolicy: {
          unboundUserMode: "reply_on_mention",
          guestPermissionProfile: "channel_context_only",
          requireIdentityFor: [
            "writes",
            "approvals",
            "private_resources",
            "runtime_sensitive_tools",
          ],
        },
      });
    });
  });

  it("binds a Feishu bot from agent settings with EventCallback advanced options", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.type(screen.getByLabelText("App ID"), "cli_planner_event");
    await user.type(screen.getByLabelText("App Secret"), "secret_planner_event");
    await user.click(screen.getByText("自定义高级功能"));
    await user.type(screen.getByLabelText("名称"), "Planner Event Bot");
    await user.selectOptions(screen.getByLabelText("连接方式"), "http_webhook");
    await user.type(screen.getByLabelText("Tenant Key"), "tenant_planner");
    await user.type(screen.getByLabelText(/Verification Token/), "verify_planner");
    await user.type(screen.getByLabelText("Encrypt Key"), "encrypt_planner");
    await user.selectOptions(screen.getByLabelText("机器人进群"), "pending_admin_review");
    await user.selectOptions(screen.getByLabelText("首次消息"), "reply_with_setup_card");
    await user.selectOptions(screen.getByLabelText("建群审核状态"), "needs_identity_binding");
    await user.selectOptions(screen.getByLabelText("未绑定用户"), "require_identity");
    await user.selectOptions(screen.getByLabelText("访客权限"), "none");
    await user.click(screen.getByRole("button", { name: "绑定 Bot 并启用工作区" }));

    await waitFor(() => {
      expect(createFeishuAgentBotBindingAction).toHaveBeenCalledWith({
        agentId: "planner",
        displayName: "Planner Event Bot",
        transportMode: "http_webhook",
        appId: "cli_planner_event",
        appSecret: "secret_planner_event",
        verificationToken: "verify_planner",
        encryptKey: "encrypt_planner",
        tenantKey: "tenant_planner",
        transferDisabledBindingId: undefined,
        channelAutoProvisioning: {
          botAdded: "pending_admin_review",
          firstMessage: "reply_with_setup_card",
          reviewStatus: "needs_identity_binding",
        },
        externalGuestPolicy: {
          unboundUserMode: "require_identity",
          guestPermissionProfile: "none",
          requireIdentityFor: [
            "writes",
            "approvals",
            "private_resources",
            "runtime_sensitive_tools",
          ],
        },
      });
    });
  });

  it("rotates EventCallback Feishu bot credentials from agent settings", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          feishuAgentBot: buildAgentFeishuBot({
            transportMode: "http_webhook",
            appId: "cli_planner_old",
            tenantKey: "tenant_old",
            hasVerificationToken: true,
            hasEncryptKey: true,
          }),
          canManageFeishuAgentBot: true,
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByText("轮换凭据", { selector: "span" }));
    await user.type(screen.getByLabelText("App ID"), "cli_planner_rotated");
    await user.type(screen.getByLabelText("新 App Secret"), "secret_rotated");
    await user.type(screen.getByLabelText("Tenant Key"), "tenant_rotated");
    await user.type(screen.getByLabelText("Verification Token"), "verify_rotated");
    await user.type(screen.getByLabelText("Encrypt Key"), "encrypt_rotated");
    await user.click(screen.getByRole("button", { name: "轮换凭据" }));

    await waitFor(() => {
      expect(rotateFeishuAgentBotCredentialsAction).toHaveBeenCalledWith({
        integrationId: "feishu-agent-bot-planner",
        appId: "cli_planner_rotated",
        appSecret: "secret_rotated",
        tenantKey: "tenant_rotated",
        verificationToken: "verify_rotated",
        encryptKey: "encrypt_rotated",
      });
    });
  });

  it("lets admins toggle channel member access for a workspace agent", async () => {
    const user = userEvent.setup();

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("switch", { name: "允许群成员调用" }));

    await waitFor(() => {
      expect(setWorkspaceAgentChannelMemberAccessAction).toHaveBeenCalledWith({
        employeeName: "planner",
        channelMemberAccess: "disabled",
      });
    });
  });

  it("lets admins toggle channel member access for a personal agent", async () => {
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      agents: [
        {
          ...data.agents[0]!,
          ownerUserId: "user-agent-owner",
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("switch", { name: "允许群成员调用" }));

    await waitFor(() => {
      expect(setWorkspaceAgentChannelMemberAccessAction).toHaveBeenCalledWith({
        employeeName: "planner",
        channelMemberAccess: "disabled",
      });
    });
  });

  it("shows server identity in the execution engine picker", async () => {
    const user = userEvent.setup();
    const dataWithEngines: AgentsPageData = {
      ...data,
      containerOptions: [
        data.containerOptions[0]!,
        {
          id: "runtime-2",
          label: "Local Runtime",
          provider: "hermes",
          status: "online",
          providerHealth: {
            runtimeStatus: "online",
            providerHealth: "healthy",
            providerUsable: "usable",
          },
          serverName: "Build Box 2",
          daemonKey: "daemon-2",
          mode: "remote",
        },
      ],
    };

    renderAgentsPage(dataWithEngines);

    await user.click(screen.getByRole("button", { name: "新建 AI员工" }));
    expect(screen.getByRole("button", { name: "执行引擎" })).toBeInTheDocument();
    expect(screen.getByText("MacBook")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行引擎" }));

    expect(screen.getByText("Build Box 2")).toBeInTheDocument();
    expect(screen.getByText("Hermes Agent")).toBeInTheDocument();
    expect(screen.getByText("daemon-2")).toBeInTheDocument();
  });

  it("uses a disabled model select until an execution engine is selected", async () => {
    const user = userEvent.setup();
    renderAgentsPage({ ...data, containerOptions: [] });

    await user.click(screen.getByRole("button", { name: "新建 AI员工" }));

    const modelSelect = screen.getByLabelText("默认模型");
    expect(modelSelect.tagName).toBe("SELECT");
    expect(modelSelect).toBeDisabled();
    expect(screen.getByRole("option", { name: "请先选择执行引擎" })).toBeInTheDocument();
  });

  it("creates an agent from the finance template with preloaded skills", async () => {
    const user = userEvent.setup();
    const dataWithPreloadedSkill: AgentsPageData = {
      ...data,
      workspaceSkills: [
        {
          id: "skill-finance",
          name: "financial-analysis-agent",
          description: "Financial analysis workflow imported from Skill Hub.",
          sourceType: "skills.sh",
          sourceUrl: "https://skills.sh/qodex-ai/ai-agent-skills/financial-analysis-agent",
          configJson: "{}",
          files: [],
          createdAt: "2026-04-10T08:00:00.000Z",
          updatedAt: "2026-04-10T08:00:00.000Z",
        },
      ],
    };

    renderAgentsPage(dataWithPreloadedSkill);

    await user.click(screen.getByRole("button", { name: "新建 AI员工" }));

    expect(screen.getByRole("button", { name: /财务分析智能体/ })).toBeInTheDocument();
    expect(screen.getByText("已准备 1/1 个预置技能")).toBeInTheDocument();
    expect(screen.getAllByText("财务分析智能体")).toHaveLength(2);
    expect(screen.getByText("模板技能由系统预置并在创建时自动绑定，无需手动导入。")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "从模板创建" }).at(-1)!);

    await waitFor(() => {
      expect(createWorkspaceAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "财务分析智能体",
          remarkName: "财务分析智能体",
          runtimeId: "runtime-1",
          templateId: "finance-analyst",
        }),
      );
    });
  });

  it("passes action invalidation hints through the workbench callback", async () => {
    const user = userEvent.setup();
    const onDataChanged = vi.fn();
    const onInvalidation = vi.fn();
    const invalidation = {
      workspaceId: "workspace-1",
      modules: ["agents" as const],
      resources: [{ type: "agent" as const, id: "Atlas" }],
      shell: "counters" as const,
    };
    vi.mocked(createWorkspaceAgentAction).mockResolvedValueOnce({
      data: undefined,
      invalidation,
    });

    renderAgentsPage(data, { onDataChanged, onInvalidation });

    await user.click(screen.getByRole("button", { name: "新建 AI员工" }));
    await user.click(screen.getAllByRole("button", { name: "从模板创建" }).at(-1)!);

    await waitFor(() => expect(createWorkspaceAgentAction).toHaveBeenCalled());
    expect(onInvalidation).toHaveBeenCalledWith(invalidation);
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("renders a help hint beside the connect server action", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage();

    const helpButton = screen.getByRole("button", { name: "接入服务器说明" });
    expect(screen.getByRole("button", { name: "接入服务器" })).toBeInTheDocument();
    expect(helpButton).toBeInTheDocument();
    await user.hover(helpButton);
    expect(await screen.findByText("接入服务器后会自动上报可用执行引擎。")).toBeInTheDocument();
  });

  it("localizes execution engine details and gives provider identity a dedicated layout", () => {
    searchParams.set("mode", "container");

    renderAgentsPage();

    expect(screen.getByText("执行提供方")).toBeInTheDocument();
    expect(screen.getByText("运行服务器")).toBeInTheDocument();
    expect(screen.getByText("版本：1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已安装应用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新执行引擎" })).toBeInTheDocument();
    expect(screen.getByText("执行引擎已接入，可为多个 AI员工 提供独立的任务执行环境。")).toBeInTheDocument();
  });

  it("groups execution engines by server and presents server and token counts together", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();
    const remoteCodex = {
      ...data.containers[0]!,
      id: "remote-codex",
      name: "172.30.30.11 Codex Runtime",
      runtimeId: "remote-codex-runtime",
      daemonKey: "remote-172-30-30-11-codex",
      deviceName: "172.30.30.11 Codex",
      daemonMode: "remote" as const,
    };
    const remoteClaude = {
      ...remoteCodex,
      id: "remote-claude",
      name: "172.30.30.11 Claude Runtime",
      runtimeId: "remote-claude-runtime",
      daemonKey: "remote-172-30-30-11-claude",
      deviceName: "172.30.30.11 Claude",
      provider: "claude-code",
    };

    renderAgentsPage({
      ...data,
      containers: [data.containers[0]!, remoteCodex, remoteClaude],
      containerCount: 3,
    });

    expect(screen.getByText("172.30.30.11")).toBeInTheDocument();
    expect(screen.getByText("远程服务器")).toBeInTheDocument();
    expect(screen.getByText("2 个引擎")).toBeInTheDocument();
    expect(screen.getAllByLabelText("2 台服务器，1 个令牌")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /172\.30\.30\.11 Codex Runtime/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开 172.30.30.11 的执行引擎" }));

    expect(screen.getByRole("button", { name: /172\.30\.30\.11 Codex Runtime/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /172\.30\.30\.11 Claude Runtime/ })).toBeInTheDocument();
  });

  it("lets regular members view execution engines assigned to them", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      canManageRuntimes: false,
      canConnectRuntimes: true,
      canManageAllAgents: false,
      daemonSnapshots: [],
      daemonTokens: [],
      containers: data.containers.map((container) => ({
        ...container,
        daemonKey: "",
        canManageGrants: false,
        grantedMembers: [],
      })),
      containerOptions: data.containerOptions.map((option) => ({
        ...option,
        daemonKey: "",
      })),
    });

    expect(screen.getByRole("heading", { name: "在线执行引擎" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开 MacBook 的执行引擎" }));
    expect(screen.getByRole("button", { name: /Local Runtime/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接入服务器" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /服务器管理/ })).not.toBeInTheDocument();
  });

  it("switches the execution engine details when a runtime row is clicked", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();
    const secondContainer = {
      ...data.containers[0],
      id: "container-2",
      name: "Cloud Runtime",
      runtimeId: "runtime-2",
      daemonKey: "daemon-2",
      deviceName: "Cloud Host",
    };

    renderAgentsPage({
      ...data,
      containers: [...data.containers, secondContainer],
      containerCount: 2,
    });

    await user.click(screen.getByRole("button", { name: "展开 MacBook 的执行引擎" }));
    await user.click(screen.getByRole("button", { name: "展开 Cloud Host 的执行引擎" }));

    const localRuntimeButton = screen.getByRole("button", { name: /^Local Runtime/ });
    const cloudRuntimeButton = screen.getByRole("button", { name: /^Cloud Runtime/ });
    expect(screen.getByRole("heading", { name: "Local Runtime" })).toBeInTheDocument();
    expect(localRuntimeButton).toHaveAttribute("aria-pressed", "true");
    expect(cloudRuntimeButton).toHaveAttribute("aria-pressed", "false");

    await user.click(cloudRuntimeButton);

    expect(screen.getByRole("heading", { name: "Cloud Runtime" })).toBeInTheDocument();
    expect(screen.getByText("服务器标识：daemon-2")).toBeInTheDocument();
    expect(localRuntimeButton).toHaveAttribute("aria-pressed", "false");
    expect(cloudRuntimeButton).toHaveAttribute("aria-pressed", "true");
  });

  it("lets regular members open the execution engine view before any engine is assigned", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage({
      ...data,
      canManageRuntimes: false,
      canConnectRuntimes: true,
      canManageAllAgents: false,
      daemonSnapshots: [],
      daemonTokens: [],
      containers: [],
      containerOptions: [],
      containerCount: 0,
      boundAgentCount: 0,
    });

    expect(screen.getByRole("heading", { name: "在线执行引擎" })).toBeInTheDocument();
    expect(screen.getByText("当前没有在线执行引擎。先接入一台服务器。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /服务器管理/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "接入服务器" }));

    expect(createContainerInstallTokenAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "接入服务器" })).toBeInTheDocument();
  });

  it("saves a custom execution engine remark", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "编辑备注名" }));
    await user.type(screen.getByLabelText("备注名"), "办公室 Mac mini");
    await user.click(screen.getByRole("button", { name: "保存备注" }));

    await waitFor(() => {
      expect(updateWorkspaceRuntimeDisplayNameAction).toHaveBeenCalledWith({
        runtimeId: "runtime-1",
        displayName: "办公室 Mac mini",
      });
    });
  });

  it("lets admins delete an execution engine from the container view", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: /删除执行引擎 Local Runtime/ }));

    await waitFor(() => {
      expect(deleteWorkspaceRuntimeAction).toHaveBeenCalledWith("runtime-1");
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("generates a bash install command from the container view", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "接入服务器" }));

    expect(createContainerInstallTokenAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "接入服务器" })).toBeInTheDocument();
    expect(screen.getByDisplayValue(/bash <\(curl -fsSL http:\/\/localhost(?::3000)?\/api\/daemon\/install-script\)/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--server-url "http:\/\/localhost(?::3000)?"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--daemon-token "adt_test"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--daemon-id "daemon-/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始检测" })).toBeDisabled();
  });

  it("clears the create server deep link through workbench navigation when mounted as a module", async () => {
    searchParams.set("mode", "container");
    searchParams.set("create", "server");
    const navigateWorkspaceModule = vi.fn(() => true);

    renderAgentsPage(data, { navigateWorkspaceModule });

    expect(await screen.findByRole("heading", { name: "接入服务器" })).toBeInTheDocument();
    expect(navigateWorkspaceModule).toHaveBeenCalledWith(
      "/w/workspace-alpha/agents?mode=container",
      { replace: true },
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("generates a bash update command for an existing runtime", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();
    let resolveInstallToken: ((value: { id: string; label: string; token: string }) => void) | undefined;
    vi.mocked(createContainerInstallTokenAction).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveInstallToken = resolve;
      }),
    );

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "更新执行引擎" }));

    expect(createContainerInstallTokenAction).toHaveBeenCalledTimes(1);
    const generatingButton = screen.getByRole("button", { name: "生成中..." });
    expect(generatingButton).toBeDisabled();
    expect(generatingButton).toHaveAttribute("aria-busy", "true");

    resolveInstallToken?.({ id: "daemon-token-1", label: "container", token: "adt_test" });

    expect(await screen.findByRole("heading", { name: "更新执行引擎" })).toBeInTheDocument();
    expect(screen.getByDisplayValue(/bash <\(curl -fsSL http:\/\/localhost(?::3000)?\/api\/daemon\/install-script\)/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--update-existing/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--server-url "http:\/\/localhost(?::3000)?"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--daemon-token "adt_test"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--daemon-id "daemon-1"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--device-name "Build Box 1"/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/--runtime-name "Remote Agent"/)).toBeInTheDocument();
    expect(screen.getByText("daemon-token-1")).toBeInTheDocument();
  });

  it("polls onboarding status after the user confirms the install command was run", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "online",
          runtimeCount: 1,
          runtimes: [{ id: "runtime-1", status: "online" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    renderAgentsPage();

    await user.click(screen.getByRole("button", { name: "接入服务器" }));
    await user.click(await screen.findByRole("button", { name: "复制命令" }));
    await user.click(screen.getByRole("button", { name: "开始检测" }));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/daemon\/onboarding-status\?daemonKey=daemon-/),
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(await screen.findByText("新执行引擎已上线。")).toBeInTheDocument();
  });

  it("shows daemon status and token management under the container tab", async () => {
    searchParams.set("mode", "container");
    const user = userEvent.setup();

    renderAgentsPage();

    expect(screen.queryByRole("heading", { name: "服务器接入令牌" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /服务器管理/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /服务器管理/ }));

    expect(screen.getByText("Build Box 1")).toBeInTheDocument();
    expect(screen.getByText("Remote Codex")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "服务器接入令牌" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建新令牌" }));

    expect(await screen.findByText("新令牌已创建")).toBeInTheDocument();
    expect(screen.getByText("adt_secret_value")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清理旧 daemon" }));

    expect(pruneOldOfflineDaemonsAction).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("polls router.refresh while daemon or work area activity is active", () => {
    vi.useFakeTimers();

    renderAgentsPage();

    vi.advanceTimersByTime(3100);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("AgentDetail", () => {
  it("saves the selected Codex execution permission policy", async () => {
    const user = userEvent.setup();
    const onSaveExecutionPolicy = vi.fn();
    const record = {
      ...data.agents[0]!,
      boundProvider: "codex",
      executionPolicy: undefined,
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={data.containerOptions}
          pending={false}
          record={record}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={vi.fn()}
          onSaveExecutionPolicy={onSaveExecutionPolicy}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "设置" }));
    const accessLevel = screen.getByRole("combobox", { name: "Codex 访问级别" });
    expect(accessLevel).toHaveValue("inherit");
    await user.selectOptions(accessLevel, "full-access");
    expect(screen.getByText(/完全访问会跳过 Codex 的审批与沙箱限制/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存执行权限" }));

    expect(onSaveExecutionPolicy).toHaveBeenCalledWith({
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
    });
  });

  it("shows installed skill readiness and opens maintenance without revealing secrets", async () => {
    const user = userEvent.setup();
    const onInstallSkill = vi.fn();
    const skill = {
      id: "skill-notion",
      name: "notion-sync",
      description: "Sync to Notion",
      sourceType: "manual" as const,
      configJson: JSON.stringify({
        requirements: [
          { kind: "config", value: "NOTION_DATABASE_ID" },
          { kind: "secret", value: "NOTION_API_TOKEN" },
        ],
      }),
      files: [],
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T08:00:00.000Z",
    };
    const record = {
      ...data.agents[0]!,
      skills: [skill],
      skillRequirements: {
        [skill.id]: {
          skillId: skill.id,
          status: "ready" as const,
          statusDetail: { code: "skill_ready" as const },
          requiredCount: 2,
          configuredCount: 2,
          blockers: [],
          environment: [
            { key: "NOTION_DATABASE_ID", kind: "config" as const, sensitive: false, configured: true },
            { key: "NOTION_API_TOKEN", kind: "secret" as const, sensitive: true, configured: true },
          ],
          configuration: {
            capabilities: [],
            values: { NOTION_DATABASE_ID: "db-123" },
            sensitiveKeys: [],
            extraKeys: [],
          },
        },
      },
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={data.containerOptions}
          pending={false}
          record={record}
          workspaceSkills={[skill]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={onInstallSkill}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "技能" }));
    expect(screen.getByText("已就绪 · 2/2 环境变量")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理环境变量" }));

    expect(screen.getByDisplayValue("db-123")).toBeInTheDocument();
    const secretInput = screen.getByLabelText("NOTION_API_TOKEN");
    expect(secretInput).toHaveValue("");
    expect(secretInput).not.toBeRequired();
    expect(screen.getByText("已配置；留空将保留当前值")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存更改" }));
    expect(onInstallSkill).toHaveBeenCalledWith(skill.id, expect.objectContaining({
      values: { NOTION_DATABASE_ID: "db-123" },
      secrets: {},
    }));
  });

  it("keeps a pending execution engine selection while the same employee refreshes", async () => {
    const user = userEvent.setup();
    const record = {
      ...data.agents[0]!,
      boundContainerId: undefined,
      boundContainerName: undefined,
      boundContainerStatus: undefined,
      boundProvider: undefined,
      boundProviderHealth: undefined,
    };
    const containerOptions = [
      data.containerOptions[0]!,
      {
        ...data.containerOptions[0]!,
        id: "runtime-2",
        label: "Second runtime",
        daemonKey: "daemon-2",
        serverName: "Server two",
      },
    ];
    const view = render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={containerOptions}
          pending={false}
          record={record}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "选择执行引擎" }));
    await user.click(screen.getByRole("option", { name: /Second runtime/ }));
    expect(screen.getByRole("button", { name: "选择执行引擎" })).toHaveTextContent("Second runtime");

    view.rerender(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={containerOptions.map((option) => ({ ...option }))}
          pending={false}
          record={{ ...record }}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "选择执行引擎" })).toHaveTextContent("Second runtime");
  });

  it("resets the execution engine selection when switching employees", async () => {
    const user = userEvent.setup();
    const firstRuntime = data.containerOptions[0]!;
    const secondRuntime = {
      ...firstRuntime,
      id: "runtime-2",
      label: "Claude runtime",
      provider: "claude" as const,
      daemonKey: "daemon-2",
      serverName: "Server two",
    };
    const firstRecord = {
      ...data.agents[0]!,
      boundContainerId: firstRuntime.id,
      boundContainerName: firstRuntime.label,
      boundProvider: firstRuntime.provider,
    };
    const secondRecord = {
      ...firstRecord,
      id: "agent:claude-e2e",
      internalName: "claude-e2e",
      name: "Claude E2E",
      boundContainerId: secondRuntime.id,
      boundContainerName: secondRuntime.label,
      boundProvider: secondRuntime.provider,
    };
    const containerOptions = [firstRuntime, secondRuntime];
    const view = render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={containerOptions}
          pending={false}
          record={firstRecord}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("button", { name: "选择执行引擎" })).toHaveTextContent(firstRuntime.label);

    view.rerender(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={containerOptions}
          pending={false}
          record={secondRecord}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onInstallSkill={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择执行引擎" })).toHaveTextContent(secondRuntime.label);
    });
  });

  it("guides an employee with no workspaces to configure an engine or start a conversation", async () => {
    const user = userEvent.setup();
    const onStartConversation = vi.fn();
    const record = {
      ...data.agents[0]!,
      workAreas: [],
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={data.containerOptions}
          pending={false}
          record={record}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetSkillIds={vi.fn()}
          onInstallSkill={vi.fn()}
          onStartConversation={onStartConversation}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "工作区" }));

    expect(screen.getByText("首次执行后自动创建工作区")).toBeInTheDocument();
    expect(screen.getByText("确认执行引擎")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看设置" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始对话" }));
    expect(onStartConversation).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "查看设置" }));
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("class", expect.stringContaining("agent-tab--active"));
  });

  it("shows the role definition as Markdown and opens editing explicitly", async () => {
    const user = userEvent.setup();
    const onSaveInstructions = vi.fn();
    const record = {
      ...data.agents[0]!,
      instructions: "# 角色\n负责将需求梳理为可执行的产品决策。\n\n## 职责\n- 明确目标与验收标准\n- 标记待确认事项",
    };

    render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={data.containerOptions}
          pending={false}
          record={record}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onSaveInstructions={onSaveInstructions}
          onSetSkillIds={vi.fn()}
          onInstallSkill={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "角色" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "职责" })).toBeInTheDocument();
    expect(screen.getByText("负责将需求梳理为可执行的产品决策。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Markdown 工作说明" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑工作说明" }));
    const editor = screen.getByRole("textbox", { name: "Markdown 工作说明" });
    await user.clear(editor);
    await user.type(editor, "# 新角色\n负责评审需求。");
    await user.click(screen.getByRole("button", { name: "保存工作说明" }));

    expect(onSaveInstructions).toHaveBeenCalledWith("# 新角色\n负责评审需求。");
    expect(screen.queryByRole("textbox", { name: "Markdown 工作说明" })).not.toBeInTheDocument();
  });

  it("searches and updates agent knowledge assignments", async () => {
    const user = userEvent.setup();
    const onSetKnowledgePageIds = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <AgentDetail
          containerOptions={data.containerOptions}
          pending={false}
          record={data.agents[0]!}
          workspaceSkills={[]}
          onBindContainer={vi.fn()}
          onDeleteAgent={vi.fn()}
          onSaveInstructions={vi.fn()}
          onSetKnowledgePageIds={onSetKnowledgePageIds}
          onSetSkillIds={vi.fn()}
          onInstallSkill={vi.fn()}
          onUnbindContainer={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "知识" }));
    await user.click(screen.getByRole("button", { name: "添加知识" }));
    await user.type(await screen.findByPlaceholderText("搜索知识页"), "legal");
    await user.click(await screen.findByRole("button", { name: /Legal memo/i }));

    await waitFor(() => {
      expect(onSetKnowledgePageIds).toHaveBeenCalledWith([
        "knowledge-planner-playbook",
        "knowledge-legal-memo",
      ]);
    });
  });
});

describe("SkillRequirementsModal", () => {
  it("lets an administrator confirm a capability-only requirement", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <SkillRequirementsModal
          configJson={JSON.stringify({
            requirements: [{ kind: "capability", value: "image_generation" }],
          })}
          pending={false}
          skillName="image-skill"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("checkbox", { name: "image_generation" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: ["image_generation"],
    }));
  });

  it("lets an administrator add an extra environment variable to the skill config", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <SkillRequirementsModal
          configJson={JSON.stringify({ requirements: [] })}
          pending={false}
          skillName="notion-skill"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>,
    );

    fireEvent.change(screen.getByLabelText("新变量键名"), { target: { value: "EXTRA_FLAG" } });
    fireEvent.change(screen.getByLabelText("新变量值"), { target: { value: "enabled" } });
    await user.click(screen.getByRole("button", { name: "添加" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      extraKeys: ["EXTRA_FLAG"],
      values: expect.objectContaining({ EXTRA_FLAG: "enabled" }),
    }));
  });

  it("keeps the modal open and flags a missing required declared value before saving", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <SkillRequirementsModal
          configJson={JSON.stringify({
            requirements: [{ kind: "config", value: "NOTION_DATABASE_ID" }],
          })}
          pending={false}
          skillName="notion-skill"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/以下字段需要补全/)).toBeTruthy();
    expect(document.querySelector('[aria-invalid="true"]')).toBeTruthy();
  });

  it("shows an upgrade diff banner with the added requirement keys", async () => {
    const onConfirm = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <SkillRequirementsModal
          configJson={JSON.stringify({
            requirements: [
              { kind: "config", value: "NEW_REQUIREMENT" },
              { kind: "config", value: "KEPT_KEY" },
            ],
          })}
          initialConfiguration={{ capabilities: [], values: { KEPT_KEY: "x" }, extraKeys: [] }}
          mode="manage"
          pending={false}
          skillName="notion-skill"
          upgradeAddedKeys={["NEW_REQUIREMENT"]}
          upgradeRemovedKeys={["OLD_KEY"]}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText(/新增要求（需补配）：NEW_REQUIREMENT/)).toBeTruthy();
    expect(screen.getByText(/移除要求（旧值已保留，可删除）：OLD_KEY/)).toBeTruthy();
  });

  it("lets an administrator remove an extra variable before saving", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <SkillRequirementsModal
          configJson={JSON.stringify({ requirements: [] })}
          initialConfiguration={{ capabilities: [], values: { EXTRA_FLAG: "x" }, extraKeys: ["EXTRA_FLAG"] }}
          pending={false}
          skillName="notion-skill"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "移除" }));
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      extraKeys: [],
      values: expect.not.objectContaining({ EXTRA_FLAG: "x" }),
    }));
  });
});

describe("SkillPickerModal", () => {
  const baseSkill = {
    id: "skill-a",
    name: "notion-sync",
    description: "Sync to Notion",
    sourceType: "manual" as const,
    configJson: "{}",
    files: [],
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T08:00:00.000Z",
  };

  it("shows the requirement status chip for each available skill", async () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <SkillPickerModal
          pending={false}
          skills={[
            {
              ...baseSkill,
              id: "skill-ready",
              name: "simple-skill",
              configJson: JSON.stringify({ requirements: [] }),
            },
            {
              ...baseSkill,
              id: "skill-config",
              name: "needs-config-skill",
              configJson: JSON.stringify({
                requirements: [{ kind: "config", value: "NOTION_DATABASE_ID" }],
              }),
            },
          ]}
          statusBySkillId={{
            "skill-ready": { tone: "positive", label: "就绪，可安装" },
            "skill-config": { tone: "warning", label: "需配置 1 项" },
          }}
          onCancel={vi.fn()}
          onSelect={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText("就绪，可安装")).toBeTruthy();
    expect(screen.getByText("需配置 1 项")).toBeTruthy();
  });
});
