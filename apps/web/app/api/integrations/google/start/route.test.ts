import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanManageEmployeeForActorSync,
  mockCreateGoogleWorkspaceAuthorizationUrl,
  mockGetCurrentWorkspaceContext,
} = vi.hoisted(() => ({
  mockAssertCanManageEmployeeForActorSync: vi.fn(),
  mockCreateGoogleWorkspaceAuthorizationUrl: vi.fn(),
  mockGetCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  assertCanManageEmployeeForActorSync: mockAssertCanManageEmployeeForActorSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

vi.mock("@/features/integrations/google-workspace", () => ({
  createGoogleWorkspaceAuthorizationUrl: mockCreateGoogleWorkspaceAuthorizationUrl,
}));

import { GET } from "./route";

describe("Google Workspace integration start route", () => {
  beforeEach(() => {
    mockAssertCanManageEmployeeForActorSync.mockReset();
    mockCreateGoogleWorkspaceAuthorizationUrl.mockReset();
    mockGetCurrentWorkspaceContext.mockReset();
    mockCreateGoogleWorkspaceAuthorizationUrl.mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?state=test");
    mockGetCurrentWorkspaceContext.mockResolvedValue({
      currentUser: {
        id: "user-1",
      },
      currentWorkspace: {
        id: "workspace-1",
        slug: "workspace-alpha",
      },
    });
  });

  it("redirects to the generated Google Workspace OAuth URL", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/google/start?redirectAfter=/w/workspace-alpha/im"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=test");
    expect(mockCreateGoogleWorkspaceAuthorizationUrl).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      agentName: undefined,
      redirectAfter: "/w/workspace-alpha/im",
    });
  });

  it("includes the agent target when delegating Google Workspace access to an agent", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/google/start?agent=planner&redirectAfter=/w/workspace-alpha/agents"));

    expect(response.status).toBe(307);
    expect(mockAssertCanManageEmployeeForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "planner",
      actorUserId: "user-1",
    });
    expect(mockCreateGoogleWorkspaceAuthorizationUrl).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      agentName: "planner",
      redirectAfter: "/w/workspace-alpha/agents",
    });
  });

  it("redirects unauthenticated users back to the app root", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/integrations/google/start"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/");
    expect(mockCreateGoogleWorkspaceAuthorizationUrl).not.toHaveBeenCalled();
  });
});
