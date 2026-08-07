import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCanReadChannelForActorSync,
  mockGetWorkspaceAccessForIdentifier,
  mockListChannelProjections,
} = vi.hoisted(() => ({
  mockCanReadChannelForActorSync: vi.fn(),
  mockGetWorkspaceAccessForIdentifier: vi.fn(),
  mockListChannelProjections: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceAccessForIdentifier: mockGetWorkspaceAccessForIdentifier,
}));

vi.mock("@dofe-agent/db", () => ({
  listOpenMontageChannelProjectionsSync: mockListChannelProjections,
}));

vi.mock("@dofe-agent/services", () => ({
  canReadChannelForActorSync: mockCanReadChannelForActorSync,
}));

import { GET } from "./route";

describe("OpenMontage channel Jobs route", () => {
  beforeEach(() => {
    mockCanReadChannelForActorSync.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockReset();
    mockListChannelProjections.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({
      status: "ok",
      context: workspaceContext(),
    });
    mockCanReadChannelForActorSync.mockReturnValue(true);
    mockListChannelProjections.mockReturnValue([
      { schemaVersion: 1, jobId: "om_job_1", status: "RUNNING", stages: [] },
    ]);
  });

  it("returns persisted Jobs for an authorized channel", async () => {
    const response = await GET(new Request("http://localhost/jobs"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "video team" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobs: [{ schemaVersion: 1, jobId: "om_job_1", status: "RUNNING", stages: [] }],
    });
    expect(mockListChannelProjections).toHaveBeenCalledWith("workspace-1", "video team");
  });

  it("does not expose Jobs when the actor cannot read the channel", async () => {
    mockCanReadChannelForActorSync.mockReturnValue(false);

    const response = await GET(new Request("http://localhost/jobs"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "private" }),
    });

    expect(response.status).toBe(403);
    expect(mockListChannelProjections).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests", async () => {
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({ status: "unauthenticated" });

    const response = await GET(new Request("http://localhost/jobs"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "video team" }),
    });

    expect(response.status).toBe(401);
    expect(mockCanReadChannelForActorSync).not.toHaveBeenCalled();
  });
});

function workspaceContext() {
  return {
    currentUser: { id: "user-1", displayName: "Tech Wu" },
    currentWorkspace: { id: "workspace-1", slug: "workspace-1", name: "Workspace" },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "member",
      status: "active",
      joinedAt: "2026-01-01T00:00:00Z",
    },
    memberships: [],
    workspaces: [],
    accessScope: "workspace",
  };
}
