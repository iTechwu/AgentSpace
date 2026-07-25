import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetCurrentWorkspaceContext,
  mockRevokeGoogleOAuthCredentialSync,
} = vi.hoisted(() => ({
  mockGetCurrentWorkspaceContext: vi.fn(),
  mockRevokeGoogleOAuthCredentialSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  revokeGoogleOAuthCredentialSync: mockRevokeGoogleOAuthCredentialSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

import { POST } from "./route";

describe("Google Workspace integration disconnect route", () => {
  beforeEach(() => {
    mockGetCurrentWorkspaceContext.mockReset();
    mockRevokeGoogleOAuthCredentialSync.mockReset();
    mockGetCurrentWorkspaceContext.mockResolvedValue({
      currentUser: {
        id: "user-1",
      },
      currentWorkspace: {
        id: "workspace-1",
      },
    });
  });

  it("revokes the current user's Google Workspace credential", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockRevokeGoogleOAuthCredentialSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized." });
  });
});
