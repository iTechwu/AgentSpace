import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetWorkspaceAccessForIdentifier,
  mockReadBinding,
  mockReadProjection,
} = vi.hoisted(() => ({
  mockGetWorkspaceAccessForIdentifier: vi.fn(),
  mockReadBinding: vi.fn(),
  mockReadProjection: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceAccessForIdentifier: mockGetWorkspaceAccessForIdentifier,
}));

vi.mock("@dofe-agent/db", () => ({
  readOpenMontageChatBindingSync: mockReadBinding,
  readOpenMontageJobProjectionSync: mockReadProjection,
}));

import { GET } from "./route";

describe("OpenMontage Job projection route", () => {
  beforeEach(() => {
    mockGetWorkspaceAccessForIdentifier.mockReset();
    mockReadBinding.mockReset();
    mockReadProjection.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({
      status: "ok",
      context: workspaceContext(),
    });
    mockReadProjection.mockReturnValue({
      schemaVersion: 1,
      jobId: "om_job_1",
      status: "RUNNING",
      stages: [],
      lastAppliedSequence: 4,
    });
  });

  it("reads the persisted projection for an authorized workspace member", async () => {
    const response = await GET(new Request("http://localhost/job"), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).job).toMatchObject({
      jobId: "om_job_1",
      lastAppliedSequence: 4,
    });
    expect(mockReadProjection).toHaveBeenCalledWith("workspace-1", "om_job_1");
  });

  it("returns not found instead of revealing a Job outside the workspace", async () => {
    mockReadProjection.mockReturnValue(null);

    const response = await GET(new Request("http://localhost/job"), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_other" }),
    });

    expect(response.status).toBe(404);
  });

  it("limits channel-scoped guests to Jobs bound to their visible channels", async () => {
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({
      status: "ok",
      context: { ...workspaceContext(), accessScope: "channel", channelNames: ["general"] },
    });
    mockReadBinding.mockReturnValue({ channelName: "private" });

    const denied = await GET(new Request("http://localhost/job"), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });
    expect(denied.status).toBe(404);

    mockReadBinding.mockReturnValue({ channelName: "general" });
    const allowed = await GET(new Request("http://localhost/job"), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("rejects unauthenticated requests before reading the projection", async () => {
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({ status: "unauthenticated" });

    const response = await GET(new Request("http://localhost/job"), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(401);
    expect(mockReadProjection).not.toHaveBeenCalled();
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
