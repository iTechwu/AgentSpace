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
  mockSetAgentSkillAssignmentsWithRequirementsValidationSync,
  mockReadAgentSkillRequirementConfigurationSync,
  mockUpsertAgentSkillRequirementsSync,
  mockReadSkillRequirementDeclarations,
  mockReadWorkspaceSkillSync,
  mockDeleteAgentSkillRequirementKeySync,
  mockEnsureManagedRuntimeModelAllowedAsync,
  mockTryRecordWorkspaceAuditEventSync,
  mockUpdateEmployeeDefaultModelSync,
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
  mockSetAgentSkillAssignmentsWithRequirementsValidationSync: vi.fn(),
  mockReadAgentSkillRequirementConfigurationSync: vi.fn(() => ({ configuredSecretKeys: [] as string[] })),
  mockUpsertAgentSkillRequirementsSync: vi.fn(),
  mockReadSkillRequirementDeclarations: vi.fn(() => [] as Array<{
    kind: "provider" | "model" | "capability" | "project" | "config" | "secret";
    value: string;
  }>),
  mockReadWorkspaceSkillSync: vi.fn(() => null),
  mockDeleteAgentSkillRequirementKeySync: vi.fn(() => ({ kind: "config" as const, sensitive: false })),
  mockEnsureManagedRuntimeModelAllowedAsync: vi.fn(),
  mockTryRecordWorkspaceAuditEventSync: vi.fn(),
  mockUpdateEmployeeDefaultModelSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  createDaemonApiTokenSync: vi.fn(),
  deleteAgentRuntimeSync: vi.fn(),
  pruneOfflineDaemonsSync: vi.fn(),
  readAgentRuntimeSync: vi.fn(),
  readEmployeeRuntimeBindingSync: vi.fn(),
  readStoredEmployeeSync: vi.fn(),
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
  ensureManagedRuntimeModelAllowedAsync: mockEnsureManagedRuntimeModelAllowedAsync,
  grantRuntimeUseToUserForActorSync: vi.fn(),
  getManagedRuntimeCredentialEnvKey: mockGetManagedRuntimeCredentialEnvKey,
  hasGitHubSkillDependenciesSync: mockHasGitHubSkillDependenciesSync,
  isWorkspaceAdminOrOwnerSync: mockIsWorkspaceAdminOrOwnerSync,
  listEmployeeSkillIdsSync: mockListEmployeeSkillIdsSync,
  readAgentSkillRequirementConfigurationSync: mockReadAgentSkillRequirementConfigurationSync,
  readSkillRequirementDeclarations: mockReadSkillRequirementDeclarations,
  readWorkspaceSkillSync: mockReadWorkspaceSkillSync,
  deleteAgentSkillRequirementKeySync: mockDeleteAgentSkillRequirementKeySync,
  resolveSystemAgentTemplateForWorkspaceSync: mockResolveSystemAgentTemplateForWorkspaceSync,
  queueGitHubSkillDependenciesForAgentSync: mockQueueGitHubSkillDependenciesForAgentSync,
  resolveAgentRuntimeMode: mockResolveAgentRuntimeMode,
  revokeAgentForkInvitationForActorSync: vi.fn(),
  revokeRuntimeUseFromUserForActorSync: vi.fn(),
  setEmployeeChannelMemberAccessSync: vi.fn(),
  setEmployeeKnowledgePageIdsSync: vi.fn(),
  setEmployeeSkillIdsSync: mockSetEmployeeSkillIdsSync,
  setAgentSkillAssignmentsWithRequirementsValidationSync: mockSetAgentSkillAssignmentsWithRequirementsValidationSync,
  tryRecordWorkspaceAuditEventSync: mockTryRecordWorkspaceAuditEventSync,
  unbindEmployeeRuntimeSync: vi.fn(),
  upsertAgentSkillRequirementsSync: mockUpsertAgentSkillRequirementsSync,
  updateEmployeeDefaultModelSync: mockUpdateEmployeeDefaultModelSync,
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
  bindWorkspaceAgentRuntimeAction,
  removeWorkspaceAgentSkillKeyAction,
  setWorkspaceAgentSkillAssignmentsAction,
  updateWorkspaceAgentDefaultModelAction,
} from "@/features/agents/actions";
import { readAgentRuntimeSync, readEmployeeRuntimeBindingSync } from "@dofe-agent/db";
import { bindEmployeeRuntimeSync } from "@dofe-agent/services";

describe("agent actions", () => {
  beforeEach(() => {
    vi.mocked(readAgentRuntimeSync).mockReset();
    vi.mocked(readEmployeeRuntimeBindingSync).mockReset();
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
    mockReadAgentSkillRequirementConfigurationSync.mockReset();
    mockTryRecordWorkspaceAuditEventSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockIsWorkspaceAdminOrOwnerSync.mockReturnValue(true);
    mockListEmployeeSkillIdsSync.mockReturnValue([]);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue(null);
    mockResolveAgentRuntimeMode.mockReturnValue("local");
    mockUpsertAgentSkillRequirementsSync.mockReturnValue(["skill-image"]);
    mockReadSkillRequirementDeclarations.mockReturnValue([]);
    mockReadWorkspaceSkillSync.mockReturnValue(null);
    mockDeleteAgentSkillRequirementKeySync.mockReturnValue({ kind: "config", sensitive: false });
    mockEnsureManagedRuntimeModelAllowedAsync.mockReset();
    mockUpdateEmployeeDefaultModelSync.mockReset();
    mockGetManagedRuntimeCredentialEnvKey.mockReturnValue("OPENAI_API_KEY");
    mockHasGitHubSkillDependenciesSync.mockReturnValue(false);
    mockReadAgentSkillRequirementConfigurationSync.mockReturnValue({ configuredSecretKeys: [] });
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

  it("allows an employee default model on the bound managed Runtime before saving it", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("remote");
    vi.mocked(readEmployeeRuntimeBindingSync).mockReturnValue({ runtimeId: "runtime-1" } as never);
    vi.mocked(readAgentRuntimeSync).mockReturnValue({
      id: "runtime-1",
      managedCredentialId: "credential-1",
    } as never);

    await updateWorkspaceAgentDefaultModelAction({
      employeeName: " Atlas ",
      defaultModel: " gpt-5.6-terra ",
    });

    expect(mockEnsureManagedRuntimeModelAllowedAsync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      actorUserId: "user-1",
      runtimeId: "runtime-1",
      modelId: "gpt-5.6-terra",
    });
    expect(mockUpdateEmployeeDefaultModelSync).toHaveBeenCalledWith(
      "Atlas",
      "gpt-5.6-terra",
      "workspace-1",
    );
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

    expect(mockSetAgentSkillAssignmentsWithRequirementsValidationSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      skillIds: ["skill-github"],
      runtimeProvider: undefined,
    });
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
      sensitiveKeys: undefined,
      assignSkill: true,
    });
    expect(mockAssertAgentSkillRequirementsReadySync).not.toHaveBeenCalled();
    expect(result.toast?.en).toContain("installed and configured for this agent");
  });

  it("emits an independent audit event when a configured secret is rotated", async () => {
    mockListEmployeeSkillIdsSync.mockReturnValue(["skill-image"]); // already assigned → manage/rotate path
    mockReadAgentSkillRequirementConfigurationSync.mockReturnValue({ configuredSecretKeys: ["IMAGE_APPKEY"] });

    await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      values: { IMAGE_BASE_URL: "https://images.example.test" },
      secrets: { IMAGE_APPKEY: "rotated-value" },
    });

    expect(mockTryRecordWorkspaceAuditEventSync).toHaveBeenCalledWith(expect.objectContaining({
      code: "workspace.agent_skill_secret_rotated",
      data: expect.objectContaining({ secretKeys: "IMAGE_APPKEY", secretCount: "1" }),
    }));
    // The secret value must never appear in any audit event payload.
    for (const call of mockTryRecordWorkspaceAuditEventSync.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("rotated-value");
    }
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
      runtimeProvider: "codex",
      assignSkill: true,
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

    expect(result.toast?.en).toBe("Skill configuration updated for this agent.");
  });

  it("records configured key names and counts by source in the install audit (never values)", async () => {
    await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      values: { IMAGE_BASE_URL: "https://images.example.test", REGION: "us-east-1" },
      secrets: { IMAGE_APPKEY: "super-secret" },
      sensitiveKeys: ["REGION"],
    });

    expect(mockTryRecordWorkspaceAuditEventSync).toHaveBeenCalledWith(expect.objectContaining({
      code: "workspace.agent_skill_requirements_configured",
      data: expect.objectContaining({
        configKeys: "IMAGE_BASE_URL",
        configKeyCount: "1",
        secretKeys: "IMAGE_APPKEY",
        secretKeyCount: "1",
        sensitiveKeys: "REGION",
        sensitiveKeyCount: "1",
      }),
    }));
    for (const call of mockTryRecordWorkspaceAuditEventSync.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("super-secret");
      expect(JSON.stringify(call)).not.toContain("https://images.example.test");
    }
  });

  it("returns a directed error when the platform encryption key is missing", async () => {
    mockUpsertAgentSkillRequirementsSync.mockImplementation(() => {
      throw new Error("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY is required to store agent skill credentials.");
    });

    const result = await installWorkspaceAgentSkillAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      secrets: { IMAGE_APPKEY: "secret-value" },
    });

    expect(result.toast?.tone).toBe("error");
    expect(result.toast?.en).toContain("DOFE_AGENT_SKILL_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("blocks binding a managed runtime whose credential key collides with an installed skill", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("remote");
    vi.mocked(readAgentRuntimeSync).mockReturnValue({ provider: "codex", workspaceId: "workspace-1" } as never);
    mockListEmployeeSkillIdsSync.mockReturnValue(["skill-openai"]);
    mockReadWorkspaceSkillSync.mockReturnValue({ name: "openai-skill" } as never);
    mockReadSkillRequirementDeclarations.mockReturnValue([
      { kind: "secret", value: "OPENAI_API_KEY" },
    ]);

    await expect(bindWorkspaceAgentRuntimeAction({
      employeeName: "Atlas",
      runtimeId: "runtime-1",
    })).rejects.toThrow(/OPENAI_API_KEY.*openai-skill/);
  });

  it("removes a single skill variable and audits the removal without values", async () => {
    await removeWorkspaceAgentSkillKeyAction({
      employeeName: "Atlas",
      skillId: "skill-image",
      key: "IMAGE_APPKEY",
    });

    expect(mockDeleteAgentSkillRequirementKeySync).toHaveBeenCalledWith(expect.objectContaining({
      employeeName: "Atlas",
      skillId: "skill-image",
      key: "IMAGE_APPKEY",
    }));
    expect(mockTryRecordWorkspaceAuditEventSync).toHaveBeenCalledWith(expect.objectContaining({
      code: "workspace.agent_skill_requirement_key_deleted",
      data: expect.objectContaining({ key: "IMAGE_APPKEY" }),
    }));
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
