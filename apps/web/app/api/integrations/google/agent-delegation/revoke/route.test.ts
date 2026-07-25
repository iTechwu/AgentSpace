import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanManageEmployeeForActorSync,
  mockGetCurrentWorkspaceContext,
  mockRevokeAgentGoogleWorkspaceDelegationSync,
} = vi.hoisted(() => ({
  mockAssertCanManageEmployeeForActorSync: vi.fn(),
  mockGetCurrentWorkspaceContext: vi.fn(),
  mockRevokeAgentGoogleWorkspaceDelegationSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  revokeAgentGoogleWorkspaceDelegationSync: mockRevokeAgentGoogleWorkspaceDelegationSync,
}));

vi.mock("@dofe-agent/services", () => ({
  assertCanManageEmployeeForActorSync: mockAssertCanManageEmployeeForActorSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

import { POST } from "./route";

describe("Google Workspace agent delegation revoke route", () => {
  beforeEach(() => {
    mockAssertCanManageEmployeeForActorSync.mockReset();
    mockGetCurrentWorkspaceContext.mockReset();
    mockRevokeAgentGoogleWorkspaceDelegationSync.mockReset();
    mockGetCurrentWorkspaceContext.mockResolvedValue({
      currentUser: {
        id: "user-1",
      },
      currentWorkspace: {
        id: "workspace-1",
      },
    });
  });

  it("revokes the current user's delegation for the selected agent", async () => {
    const response = await POST(new Request("http://localhost/api/integrations/google/agent-delegation/revoke", {
      method: "POST",
      body: JSON.stringify({ employeeName: "planner" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockAssertCanManageEmployeeForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "planner",
      actorUserId: "user-1",
    });
    expect(mockRevokeAgentGoogleWorkspaceDelegationSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "planner",
      userId: "user-1",
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost/api/integrations/google/agent-delegation/revoke", {
      method: "POST",
      body: JSON.stringify({ employeeName: "planner" }),
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });
});
