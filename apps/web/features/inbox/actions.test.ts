import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockArchiveNotificationSync,
  mockMarkNotificationReadSync,
  mockReadWorkspaceStateSync,
  mockRequireCurrentWorkspaceContext,
  mockRevalidateWorkspacePaths,
  mockUpdateTaskStatusSync,
} = vi.hoisted(() => ({
  mockArchiveNotificationSync: vi.fn(),
  mockMarkNotificationReadSync: vi.fn(),
  mockReadWorkspaceStateSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
  mockUpdateTaskStatusSync: vi.fn(),
}));

vi.mock("@agent-space/services", () => ({
  archiveNotificationSync: mockArchiveNotificationSync,
  markNotificationReadSync: mockMarkNotificationReadSync,
  readWorkspaceStateSync: mockReadWorkspaceStateSync,
  sameValue: (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase(),
  updateTaskStatusSync: mockUpdateTaskStatusSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

import {
  archiveInboxNotificationAction,
  markInboxNotificationReadAction,
  updateInboxTaskStatusAction,
} from "@/features/inbox/actions";

describe("inbox actions", () => {
  beforeEach(() => {
    mockArchiveNotificationSync.mockReset();
    mockMarkNotificationReadSync.mockReset();
    mockReadWorkspaceStateSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockUpdateTaskStatusSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockMarkNotificationReadSync.mockReturnValue({ id: "notification-1" });
    mockArchiveNotificationSync.mockReturnValue({ id: "notification-1" });
  });

  it("returns a targeted invalidation hint when updating task status", async () => {
    const result = await updateInboxTaskStatusAction("task-1", "done");

    expect(mockUpdateTaskStatusSync).toHaveBeenCalledWith("task-1", "done", "workspace-1");
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-alpha", [
      "/inbox",
      "/agents",
      "/im",
      "/market",
      "/task-board",
    ]);
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["inbox", "task-board", "agents", "im"],
      resources: [{ type: "task", id: "task-1" }],
      shell: "counters",
    });
  });

  it("returns a targeted invalidation hint when marking notifications read", async () => {
    const result = await markInboxNotificationReadAction("notification:notification-1");

    expect(mockMarkNotificationReadSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      notificationId: "notification-1",
      recipient: {
        recipientType: "human",
        recipientId: "user-1",
      },
    });
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["inbox"],
      shell: "counters",
    });
  });

  it("returns a targeted invalidation hint when archiving notifications", async () => {
    const result = await archiveInboxNotificationAction("notification-1");

    expect(mockArchiveNotificationSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      notificationId: "notification-1",
      recipient: {
        recipientType: "human",
        recipientId: "user-1",
      },
    });
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["inbox"],
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
