import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanUseEmployeeInChannelForActorSync,
  mockReadWorkspaceStateSync,
  mockRequireCurrentWorkspaceContext,
  mockRevalidateWorkspacePaths,
  mockUpdateTaskStatusSync,
} = vi.hoisted(() => ({
  mockAssertCanUseEmployeeInChannelForActorSync: vi.fn(),
  mockReadWorkspaceStateSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
  mockUpdateTaskStatusSync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  addTaskLabelSync: vi.fn(),
  assertCanUseEmployeeInChannelForActorSync: mockAssertCanUseEmployeeInChannelForActorSync,
  estimateTaskSync: vi.fn(),
  readWorkspaceStateSync: mockReadWorkspaceStateSync,
  removeTaskLabelSync: vi.fn(),
  reorderTaskSync: vi.fn(),
  updateTaskStatusSync: mockUpdateTaskStatusSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

import { moveTaskToColumnAction } from "@/features/task-board/actions";

describe("task-board actions", () => {
  beforeEach(() => {
    mockAssertCanUseEmployeeInChannelForActorSync.mockReset();
    mockReadWorkspaceStateSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockUpdateTaskStatusSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockReadWorkspaceStateSync.mockReturnValue({
      tasks: [
        {
          id: "task-1",
          assignee: "Atlas",
          channel: "travel",
        },
      ],
    });
  });

  it("returns an invalidation hint when moving a task", async () => {
    const result = await moveTaskToColumnAction("task-1", "done");

    expect(mockAssertCanUseEmployeeInChannelForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      channelName: "travel",
      actorUserId: "user-1",
      actorDisplayName: "techwu",
      actorRole: "owner",
    });
    expect(mockUpdateTaskStatusSync).toHaveBeenCalledWith("task-1", "done", "workspace-1");
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-alpha", ["/task/board", "/inbox", "/agents"]);
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["task-board", "inbox", "agents"],
      resources: [{ type: "task", id: "task-1" }],
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
