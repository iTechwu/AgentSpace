import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetWorkspaceContextForIdentifier,
  mockGetWorkspaceShellCounterData,
} = vi.hoisted(() => ({
  mockGetWorkspaceContextForIdentifier: vi.fn(),
  mockGetWorkspaceShellCounterData: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceContextForIdentifier: mockGetWorkspaceContextForIdentifier,
}));

vi.mock("@/features/dashboard/workspace-shell-data", () => ({
  getWorkspaceShellCounterData: mockGetWorkspaceShellCounterData,
}));

import { GET } from "./route";

describe("workspace shell counters route", () => {
  beforeEach(() => {
    mockGetWorkspaceContextForIdentifier.mockReset();
    mockGetWorkspaceShellCounterData.mockReset();
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext());
    mockGetWorkspaceShellCounterData.mockReturnValue(buildCounters());
  });

  it("returns derived shell counters for the current workspace", async () => {
    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/shell-counters"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetWorkspaceContextForIdentifier).toHaveBeenCalledWith("workspace-alpha");
    expect(mockGetWorkspaceShellCounterData).toHaveBeenCalledWith("techwu", "workspace-1", "user-1", "owner", undefined);
    expect(payload).toMatchObject({
      data: {
        unreadNotificationCount: 5,
        openTaskCount: 3,
        pendingApprovalCount: 2,
        skillCount: 4,
        knowledgePageCount: 7,
        humanContactCount: 1,
        agentCount: 2,
        runtimeCount: 1,
      },
      meta: {
        durationMs: expect.any(Number),
        workspaceId: "workspace-1",
        workspaceSlug: "workspace-alpha",
      },
    });
  });

  it("uses channel scope when the viewer is channel scoped", async () => {
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext({
      accessScope: "channel",
      channelNames: ["general"],
    }));

    await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/shell-counters"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );

    expect(mockGetWorkspaceShellCounterData).toHaveBeenCalledWith("techwu", "workspace-1", "user-1", "owner", {
      channelNames: ["general"],
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/shell-counters"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );

    expect(response.status).toBe(401);
    expect(mockGetWorkspaceShellCounterData).not.toHaveBeenCalled();
  });
});

function buildWorkspaceContext(options: { accessScope?: "workspace" | "channel"; channelNames?: string[] } = {}) {
  return {
    accessScope: options.accessScope ?? "workspace",
    channelNames: options.channelNames,
    currentUser: {
      id: "user-1",
      displayName: "techwu",
      email: "techwu@example.com",
      organizationName: "Northstar Labs",
      role: "owner",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-alpha",
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "owner",
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}

function buildCounters() {
  return {
    humanMembers: 2,
    channelCount: 3,
    messageCount: 6,
    unreadNotificationCount: 5,
    openTaskCount: 3,
    pendingApprovalCount: 2,
    localAgentCount: 2,
    remoteAgentCount: 1,
    skillCount: 4,
    knowledgePageCount: 7,
    contactCount: 3,
    humanContactCount: 1,
    agentCount: 2,
    runtimeCount: 1,
  };
}
