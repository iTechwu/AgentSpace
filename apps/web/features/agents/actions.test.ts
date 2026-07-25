import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanUseEmployeeInChannelForActorSync,
  mockCreateEmployeeSync,
  mockCreateTaskSync,
  mockIsWorkspaceAdminOrOwnerSync,
  mockRequireCurrentWorkspaceContext,
  mockResolveSystemAgentTemplateForWorkspaceSync,
  mockRevalidateWorkspacePaths,
} = vi.hoisted(() => ({
  mockAssertCanUseEmployeeInChannelForActorSync: vi.fn(),
  mockCreateEmployeeSync: vi.fn(),
  mockCreateTaskSync: vi.fn(),
  mockIsWorkspaceAdminOrOwnerSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockResolveSystemAgentTemplateForWorkspaceSync: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
}));

vi.mock("@agent-space/db", () => ({
  createDaemonApiTokenSync: vi.fn(),
  deleteAgentRuntimeSync: vi.fn(),
  pruneOfflineDaemonsSync: vi.fn(),
  readAgentRuntimeSync: vi.fn(),
  revokeAgentGoogleWorkspaceDelegationSync: vi.fn(),
  updateWorkspaceRuntimeDisplayNameSync: vi.fn(),
}));

vi.mock("@agent-space/services", () => ({
  acceptAgentForkInvitationForActorSync: vi.fn(),
  assertCanManageEmployeeForActorSync: vi.fn(),
  assertCanUseEmployeeInChannelForActorSync: mockAssertCanUseEmployeeInChannelForActorSync,
  assertCanUseRuntimeForActorSync: vi.fn(),
  bindEmployeeRuntimeSync: vi.fn(),
  createAgentForkInvitationForActorSync: vi.fn(),
  createEmployeeSync: mockCreateEmployeeSync,
  createTaskSync: mockCreateTaskSync,
  deleteEmployeeSync: vi.fn(),
  grantRuntimeUseToUserForActorSync: vi.fn(),
  isWorkspaceAdminOrOwnerSync: mockIsWorkspaceAdminOrOwnerSync,
  resolveSystemAgentTemplateForWorkspaceSync: mockResolveSystemAgentTemplateForWorkspaceSync,
  revokeAgentForkInvitationForActorSync: vi.fn(),
  revokeRuntimeUseFromUserForActorSync: vi.fn(),
  setEmployeeChannelMemberAccessSync: vi.fn(),
  setEmployeeKnowledgePageIdsSync: vi.fn(),
  setEmployeeSkillIdsSync: vi.fn(),
  tryRecordWorkspaceAuditEventSync: vi.fn(),
  unbindEmployeeRuntimeSync: vi.fn(),
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
} from "@/features/agents/actions";

describe("agent actions", () => {
  beforeEach(() => {
    mockAssertCanUseEmployeeInChannelForActorSync.mockReset();
    mockCreateEmployeeSync.mockReset();
    mockCreateTaskSync.mockReset();
    mockIsWorkspaceAdminOrOwnerSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockIsWorkspaceAdminOrOwnerSync.mockReturnValue(true);
    mockResolveSystemAgentTemplateForWorkspaceSync.mockReturnValue(null);
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
      "/task-board",
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
