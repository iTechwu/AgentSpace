import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanUseEmployeeInChannelForActorSync,
  mockAssertAgentSkillRequirementsReadySync,
  mockAssertRuntimeCanBindEmployeeSync,
  mockCreateEmployeeSync,
  mockCreateTaskSync,
  mockGetManagedRuntimeCredentialEnvKey,
  mockHasGitHubSkillDependenciesSync,
  mockIsWorkspaceAdminOrOwnerSync,
  mockListEmployeeSkillIdsSync,
  mockRequireCurrentWorkspaceContext,
  mockResolveSystemAgentTemplateForWorkspaceSync,
  mockResolveAgentRuntimeMode,
  mockQueueGitHubSkillDependenciesForAgentSync,
  mockRevalidateWorkspacePaths,
  mockSetEmployeeSkillIdsSync,
  mockUpsertAgentSkillRequirementsSync,
} = vi.hoisted(() => ({
  mockAssertCanUseEmployeeInChannelForActorSync: vi.fn(),
  mockAssertAgentSkillRequirementsReadySync: vi.fn(),
  mockAssertRuntimeCanBindEmployeeSync: vi.fn(),
  mockCreateEmployeeSync: vi.fn(),
  mockCreateTaskSync: vi.fn(),
  mockGetManagedRuntimeCredentialEnvKey: vi.fn(),
  mockHasGitHubSkillDependenciesSync: vi.fn(),
  mockIsWorkspaceAdminOrOwnerSync: vi.fn(),
  mockListEmployeeSkillIdsSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockResolveSystemAgentTemplateForWorkspaceSync: vi.fn(),
  mockResolveAgentRuntimeMode: vi.fn(),
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
  updateWorkspaceRuntimeDisplayNameSync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  acceptAgentForkInvitationForActorSync: vi.fn(),
  assertCanManageEmployeeForActorSync: vi.fn(),
  assertAgentSkillRequirementsReadySync: mockAssertAgentSkillRequirementsReadySync,
  assertRuntimeCanBindEmployeeSync: mockAssertRuntimeCanBindEmployeeSync,
  assertCanUseEmployeeInChannelForActorSync: mockAssertCanUseEmployeeInChannelForActorSync,
  assertCanUseRuntimeForActorSync: vi.fn(),
  bindEmployeeRuntimeSync: vi.fn(),
  createAgentForkInvitationForActorSync: vi.fn(),
  createEmployeeSync: mockCreateEmployeeSync,
  createTaskSync: mockCreateTaskSync,
  deleteEmployeeSync: vi.fn(),
  grantRuntimeUseToUserForActorSync: vi.fn(),
  getManagedRuntimeCredentialEnvKey: mockGetManagedRuntimeCredentialEnvKey,
  hasGitHubSkillDependenciesSync: mockHasGitHubSkillDependenciesSync,
  isWorkspaceAdminOrOwnerSync: mockIsWorkspaceAdminOrOwnerSync,
  listEmployeeSkillIdsSync: mockListEmployeeSkillIdsSync,
  resolveSystemAgentTemplateForWorkspaceSync: mockResolveSystemAgentTemplateForWorkspaceSync,
  queueGitHubSkillDependenciesForAgentSync: mockQueueGitHubSkillDependenciesForAgentSync,
  resolveAgentRuntimeMode: mockResolveAgentRuntimeMode,
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
  createContainerInstallTokenAction,
  createWorkspaceAgentAction,
  createWorkspaceTaskAction,
  installWorkspaceAgentSkillAction,
  setWorkspaceAgentSkillAssignmentsAction,
} from "@/features/agents/actions";
import { readAgentRuntimeSync, readEmployeeRuntimeBindingSync } from "@dofe-agent/db";
import { bindEmployeeRuntimeSync } from "@dofe-agent/services";

describe("agent actions", () => {
  beforeEach(() => {
    mockAssertCanUseEmployeeInChannelForActorSync.mockReset();
    mockAssertAgentSkillRequirementsReadySync.mockReset();
    mockAssertRuntimeCanBindEmployeeSync.mockReset();
    mockCreateEmployeeSync.mockReset();
    mockCreateTaskSync.mockReset();
    mockGetManagedRuntimeCredentialEnvKey.mockReset();
    mockHasGitHubSkillDependenciesSync.mockReset();
    mockIsWorkspaceAdminOrOwnerSync.mockReset();
    mockListEmployeeSkillIdsSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReset();
    mockResolveAgentRuntimeMode.mockReset();
  mockQueueGitHubSkillDependenciesForAgentSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockSetEmployeeSkillIdsSync.mockReset();
    mockUpsertAgentSkillRequirementsSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockIsWorkspaceAdminOrOwnerSync.mockReturnValue(true);
    mockListEmployeeSkillIdsSync.mockReturnValue([]);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue(null);
    mockResolveAgentRuntimeMode.mockReturnValue("local");
    mockGetManagedRuntimeCredentialEnvKey.mockReturnValue("OPENAI_API_KEY");
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

  it("rejects members from creating an AI employee even when a runtime is supplied", async () => {
    mockIsWorkspaceAdminOrOwnerSync.mockReturnValue(false);

    await expect(createWorkspaceAgentAction({
      name: "Atlas",
      runtimeId: "runtime-granted-to-member",
    })).rejects.toThrow("Only workspace owners and admins can manage AI employees.");

    expect(mockCreateEmployeeSync).not.toHaveBeenCalled();
  });

  it("rejects an unready remote runtime before creating an AI employee", async () => {
    vi.mocked(readAgentRuntimeSync).mockReturnValue({
      id: "runtime-1",
      workspaceId: "workspace-1",
      provider: "codex",
    } as never);
    mockAssertRuntimeCanBindEmployeeSync.mockImplementation(() => {
      throw new Error("runtime.managed_runtime_not_ready");
    });

    await expect(createWorkspaceAgentAction({ name: "Atlas", runtimeId: "runtime-1" }))
      .rejects.toThrow("runtime.managed_runtime_not_ready");

    expect(mockCreateEmployeeSync).not.toHaveBeenCalled();
  });

  it("rejects manual daemon installation tokens in remote mode", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("remote");

    await expect(createContainerInstallTokenAction())
      .rejects.toThrow("manual_runtime.remote_mode_required");
  });

  it("runs skill-readiness preflight before creating an agent bound to a runtime", async () => {
    vi.mocked(readAgentRuntimeSync).mockReturnValue({
      id: "runtime-1",
      workspaceId: "workspace-1",
      provider: "codex",
    } as never);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue({
      template: { id: "finance-analyst" },
      skillIds: ["skill-a"],
    } as never);
    vi.mocked(bindEmployeeRuntimeSync).mockClear();

    await createWorkspaceAgentAction({ name: "Atlas", runtimeId: "runtime-1", templateId: "finance-analyst" });

    expect(mockAssertAgentSkillRequirementsReadySync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      skillIds: ["skill-a"],
      runtimeProvider: "codex",
    }));
    expect(vi.mocked(bindEmployeeRuntimeSync)).toHaveBeenCalledWith("Atlas", "runtime-1", "workspace-1");
  });

  it("does not create an agent when skill readiness preflight fails", async () => {
    vi.mocked(readAgentRuntimeSync).mockReturnValue({
      id: "runtime-1",
      workspaceId: "workspace-1",
      provider: "codex",
    } as never);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue({
      template: { id: "finance-analyst" },
      skillIds: ["skill-a"],
    } as never);
    vi.mocked(bindEmployeeRuntimeSync).mockClear();
    mockAssertAgentSkillRequirementsReadySync.mockImplementation(() => {
      throw new Error("skill requirements not ready");
    });

    await expect(createWorkspaceAgentAction({ name: "Atlas", runtimeId: "runtime-1", templateId: "finance-analyst" }))
      .rejects.toThrow("skill requirements not ready");

    expect(mockCreateEmployeeSync).not.toHaveBeenCalled();
    expect(vi.mocked(bindEmployeeRuntimeSync)).not.toHaveBeenCalled();
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
    expect(result.toast?.en).toContain("2 controlled dependency install(s) queued");
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
    expect(result.toast?.en).toContain("installed and configured for this agent");
  });

  it("passes the bound managed runtime credential key to skill validation", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("remote");
    vi.mocked(readEmployeeRuntimeBindingSync).mockReturnValue({ provider: "codex" } as never);

    await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-openai",
      secrets: { OPENAI_API_KEY: "skill-secret" },
    });

    expect(mockGetManagedRuntimeCredentialEnvKey).toHaveBeenCalledWith("codex");
    expect(mockUpsertAgentSkillRequirementsSync).toHaveBeenCalledWith(expect.objectContaining({
      employeeName: "Atlas",
      skillId: "skill-openai",
      managedRuntimeCredentialKey: "OPENAI_API_KEY",
    }));
  });

  it("reports configuration maintenance without claiming the skill was installed again", async () => {
    mockListEmployeeSkillIdsSync.mockReturnValue(["skill-image"]);

    const result = await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      values: { IMAGE_BASE_URL: "https://images.example.test/v2" },
      secrets: {},
    });

    expect(mockSetEmployeeSkillIdsSync).toHaveBeenCalledWith("Atlas", ["skill-image"], "workspace-1");
    expect(result.toast?.en).toBe("Skill configuration updated for this agent.");
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
