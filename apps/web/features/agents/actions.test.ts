import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanUseEmployeeInChannelForActorSync,
  mockAssertAgentSkillRequirementsReadySync,
  mockCreateEmployeeSync,
  mockCreateTaskSync,
  mockHasGitHubSkillDependenciesSync,
  mockIsWorkspaceAdminOrOwnerSync,
  mockListEmployeeSkillIdsSync,
  mockRequireCurrentWorkspaceContext,
  mockResolveSystemAgentTemplateForWorkspaceSync,
  mockQueueGitHubSkillDependenciesForAgentSync,
  mockRevalidateWorkspacePaths,
  mockSetEmployeeSkillIdsSync,
  mockUpsertAgentSkillRequirementsSync,
} = vi.hoisted(() => ({
  mockAssertCanUseEmployeeInChannelForActorSync: vi.fn(),
  mockAssertAgentSkillRequirementsReadySync: vi.fn(),
  mockCreateEmployeeSync: vi.fn(),
  mockCreateTaskSync: vi.fn(),
  mockHasGitHubSkillDependenciesSync: vi.fn(),
  mockIsWorkspaceAdminOrOwnerSync: vi.fn(),
  mockListEmployeeSkillIdsSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockResolveSystemAgentTemplateForWorkspaceSync: vi.fn(),
  mockQueueGitHubSkillDependenciesForAgentSync: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
  mockSetEmployeeSkillIdsSync: vi.fn(),
  mockUpsertAgentSkillRequirementsSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  createDaemonApiTokenSync: vi.fn(),
  deleteAgentRuntimeSync: vi.fn(),
  pruneOfflineDaemonsSync: vi.fn(),
  readAgentRuntimeSync: vi.fn(),
  readEmployeeRuntimeBindingSync: vi.fn(),
  revokeAgentGoogleWorkspaceDelegationSync: vi.fn(),
  updateWorkspaceRuntimeDisplayNameSync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  acceptAgentForkInvitationForActorSync: vi.fn(),
  assertCanManageEmployeeForActorSync: vi.fn(),
  assertAgentSkillRequirementsReadySync: mockAssertAgentSkillRequirementsReadySync,
  assertCanUseEmployeeInChannelForActorSync: mockAssertCanUseEmployeeInChannelForActorSync,
  assertCanUseRuntimeForActorSync: vi.fn(),
  bindEmployeeRuntimeSync: vi.fn(),
  createAgentForkInvitationForActorSync: vi.fn(),
  createEmployeeSync: mockCreateEmployeeSync,
  createTaskSync: mockCreateTaskSync,
  deleteEmployeeSync: vi.fn(),
  grantRuntimeUseToUserForActorSync: vi.fn(),
  hasGitHubSkillDependenciesSync: mockHasGitHubSkillDependenciesSync,
  isWorkspaceAdminOrOwnerSync: mockIsWorkspaceAdminOrOwnerSync,
  listEmployeeSkillIdsSync: mockListEmployeeSkillIdsSync,
  resolveSystemAgentTemplateForWorkspaceSync: mockResolveSystemAgentTemplateForWorkspaceSync,
  queueGitHubSkillDependenciesForAgentSync: mockQueueGitHubSkillDependenciesForAgentSync,
  revokeAgentForkInvitationForActorSync: vi.fn(),
  revokeRuntimeUseFromUserForActorSync: vi.fn(),
  setEmployeeChannelMemberAccessSync: vi.fn(),
  setEmployeeKnowledgePageIdsSync: vi.fn(),
  setEmployeeSkillIdsSync: mockSetEmployeeSkillIdsSync,
  tryRecordWorkspaceAuditEventSync: vi.fn(),
  unbindEmployeeRuntimeSync: vi.fn(),
  upsertAgentSkillRequirementsSync: mockUpsertAgentSkillRequirementsSync,
  updateEmployeeInstructionsSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePath: vi.fn(),
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

import {
  createWorkspaceAgentAction,
  createWorkspaceTaskAction,
  installWorkspaceAgentSkillAction,
  setWorkspaceAgentSkillAssignmentsAction,
} from "@/features/agents/actions";

describe("agent actions", () => {
  beforeEach(() => {
    mockAssertCanUseEmployeeInChannelForActorSync.mockReset();
    mockAssertAgentSkillRequirementsReadySync.mockReset();
    mockCreateEmployeeSync.mockReset();
    mockCreateTaskSync.mockReset();
    mockHasGitHubSkillDependenciesSync.mockReset();
    mockIsWorkspaceAdminOrOwnerSync.mockReset();
    mockListEmployeeSkillIdsSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReset();
  mockQueueGitHubSkillDependenciesForAgentSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockSetEmployeeSkillIdsSync.mockReset();
    mockUpsertAgentSkillRequirementsSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockIsWorkspaceAdminOrOwnerSync.mockReturnValue(true);
    mockListEmployeeSkillIdsSync.mockReturnValue([]);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue(null);
    mockHasGitHubSkillDependenciesSync.mockReturnValue(false);
    mockQueueGitHubSkillDependenciesForAgentSync.mockReturnValue({ queued: 0, skipped: 0, waitingForRuntime: false });
    mockCreateTaskSync.mockReturnValue({
      tasks: [
        {
          id: "task-1",
          title: "Plan Osaka",
          channel: "travel",
          assignee: "Atlas",
          priority: "high",
          status: "todo",
        },
      ],
    });
  });

  it("returns an invalidation hint when creating an agent", async () => {
    const result = await createWorkspaceAgentAction({
      name: "Atlas",
      remarkName: "Travel Atlas",
    });

    expect(mockCreateEmployeeSync).toHaveBeenCalledWith(expect.objectContaining({
      name: "Atlas",
      remarkName: "Travel Atlas",
      active: true,
    }), "workspace-1");
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-alpha", [
      "/inbox",
      "/agents",
      "/im",
      "/market",
      "/skills",
      "/knowledge",
      "/task/board",
    ]);
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["agents", "inbox", "im", "market", "skills", "knowledge", "task-board"],
      resources: [{ type: "agent", id: "Atlas" }],
      shell: "counters",
    });
  });

  it("returns an invalidation hint when creating a task", async () => {
    const result = await createWorkspaceTaskAction({
      title: "Plan Osaka",
      channel: "travel",
      assignee: "Atlas",
      priority: "high",
    });

    expect(mockAssertCanUseEmployeeInChannelForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      channelName: "travel",
      actorUserId: "user-1",
      actorDisplayName: "techwu",
      actorRole: "owner",
    });
    expect(mockCreateTaskSync).toHaveBeenCalledWith({
      title: "Plan Osaka",
      channel: "travel",
      assignee: "Atlas",
      priority: "high",
      requestedByUserId: "user-1",
      requestedByDisplayName: "techwu",
    }, "workspace-1");
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["agents", "inbox", "task-board", "im"],
      resources: [
        { type: "task", id: "task-1" },
        { type: "agent", id: "Atlas" },
      ],
      shell: "counters",
    });
  });

  it("queues declared GitHub skill dependencies when an admin assigns the skill", async () => {
    mockHasGitHubSkillDependenciesSync.mockReturnValue(true);
    mockQueueGitHubSkillDependenciesForAgentSync.mockReturnValue({ queued: 2, skipped: 0, waitingForRuntime: false });

    const result = await setWorkspaceAgentSkillAssignmentsAction({
      employeeName: "Atlas",
      skillIds: ["skill-github"],
    });

    expect(mockSetEmployeeSkillIdsSync).toHaveBeenCalledWith("Atlas", ["skill-github"], "workspace-1");
    expect(mockQueueGitHubSkillDependenciesForAgentSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      skillIds: ["skill-github"],
      actorUserId: "user-1",
      actorDisplayName: "techwu",
    });
    expect(result.toast.en).toContain("2 controlled dependency install(s) queued");
  });

  it("stores requirements for the target agent before assigning the skill", async () => {
    const result = await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      modelProvider: "codex",
      modelId: "gpt-image-1",
      capabilities: ["image_generation"],
      projectWorkDir: "/workspace/creative",
      values: { IMAGE_BASE_URL: "https://images.example.test" },
      secrets: { IMAGE_APPKEY: "secret-value" },
    });

    expect(mockUpsertAgentSkillRequirementsSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      skillId: "skill-image",
      actorUserId: "user-1",
      modelProvider: "codex",
      modelId: "gpt-image-1",
      capabilities: ["image_generation"],
      projectWorkDir: "/workspace/creative",
      values: { IMAGE_BASE_URL: "https://images.example.test" },
      secrets: { IMAGE_APPKEY: "secret-value" },
    });
    expect(mockAssertAgentSkillRequirementsReadySync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      skillIds: ["skill-image"],
      runtimeProvider: undefined,
    });
    expect(mockSetEmployeeSkillIdsSync).toHaveBeenCalledWith("Atlas", ["skill-image"], "workspace-1");
    expect(result.toast.en).toContain("installed and configured for this agent");
  });
});

function buildWorkspaceContext() {
  return {
    currentUser: {
      id: "user-1",
      displayName: "techwu",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-alpha",
    },
    currentMembership: {
      role: "owner",
    },
  };
}
