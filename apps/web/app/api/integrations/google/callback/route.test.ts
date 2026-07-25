import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertCanManageEmployeeForActorSync,
  mockGetCurrentUser,
  mockReadGoogleWorkspaceOAuthConfig,
  mockReadWorkspaceMembershipSync,
  mockSaveGoogleWorkspaceCredentialFromAuthorizationCode,
  mockUpsertAgentGoogleWorkspaceDelegationSync,
  mockVerifyGoogleWorkspaceOAuthCallbackState,
} = vi.hoisted(() => ({
  mockAssertCanManageEmployeeForActorSync: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockReadGoogleWorkspaceOAuthConfig: vi.fn(),
  mockReadWorkspaceMembershipSync: vi.fn(),
  mockSaveGoogleWorkspaceCredentialFromAuthorizationCode: vi.fn(),
  mockUpsertAgentGoogleWorkspaceDelegationSync: vi.fn(),
  mockVerifyGoogleWorkspaceOAuthCallbackState: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  readWorkspaceMembershipSync: mockReadWorkspaceMembershipSync,
  upsertAgentGoogleWorkspaceDelegationSync: mockUpsertAgentGoogleWorkspaceDelegationSync,
}));

vi.mock("@dofe-agent/services", () => ({
  assertCanManageEmployeeForActorSync: mockAssertCanManageEmployeeForActorSync,
}));

vi.mock("@/features/auth/server-auth", () => ({
  getCurrentUser: mockGetCurrentUser,
}));

vi.mock("@/features/integrations/google-workspace", () => ({
  readGoogleWorkspaceOAuthConfig: mockReadGoogleWorkspaceOAuthConfig,
  saveGoogleWorkspaceCredentialFromAuthorizationCode: mockSaveGoogleWorkspaceCredentialFromAuthorizationCode,
  verifyGoogleWorkspaceOAuthCallbackState: mockVerifyGoogleWorkspaceOAuthCallbackState,
}));

import { GET } from "./route";

describe("Google Workspace integration callback route", () => {
  beforeEach(() => {
    mockAssertCanManageEmployeeForActorSync.mockReset();
    mockGetCurrentUser.mockReset();
    mockReadGoogleWorkspaceOAuthConfig.mockReset();
    mockReadWorkspaceMembershipSync.mockReset();
    mockSaveGoogleWorkspaceCredentialFromAuthorizationCode.mockReset();
    mockUpsertAgentGoogleWorkspaceDelegationSync.mockReset();
    mockVerifyGoogleWorkspaceOAuthCallbackState.mockReset();
    mockReadGoogleWorkspaceOAuthConfig.mockReturnValue({ appUrl: "http://app.test" });
    mockVerifyGoogleWorkspaceOAuthCallbackState.mockResolvedValue({
      workspaceId: "workspace-1",
      userId: "user-1",
      redirectAfter: "/w/workspace-alpha/im",
    });
    mockGetCurrentUser.mockResolvedValue({ id: "user-1" });
    mockReadWorkspaceMembershipSync.mockReturnValue({ status: "active" });
    mockSaveGoogleWorkspaceCredentialFromAuthorizationCode.mockResolvedValue({
      id: "google-oauth-1",
      scopes: "https://www.googleapis.com/auth/drive.file",
      googleEmail: "owner@example.com",
    });
  });

  it("stores an agent delegation when the OAuth state targets an agent", async () => {
    mockVerifyGoogleWorkspaceOAuthCallbackState.mockResolvedValue({
      workspaceId: "workspace-1",
      userId: "user-1",
      agentName: "planner",
      redirectAfter: "/w/workspace-alpha/agents",
    });

    const response = await GET(new Request("http://localhost/api/integrations/google/callback?code=code-1&state=state-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://app.test/w/workspace-alpha/agents?agentGoogleWorkspace=connected");
    expect(mockAssertCanManageEmployeeForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "planner",
      actorUserId: "user-1",
    });
    expect(mockUpsertAgentGoogleWorkspaceDelegationSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      employeeName: "planner",
      userId: "user-1",
      googleOAuthCredentialId: "google-oauth-1",
      scopes: "https://www.googleapis.com/auth/drive.file",
      googleEmail: "owner@example.com",
      grantedByUserId: "user-1",
    });
  });

  it("stores the credential and returns to the requested workspace path", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/google/callback?code=code-1&state=state-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://app.test/w/workspace-alpha/im?googleWorkspace=connected");
    expect(mockVerifyGoogleWorkspaceOAuthCallbackState).toHaveBeenCalledWith("state-1");
    expect(mockSaveGoogleWorkspaceCredentialFromAuthorizationCode).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      code: "code-1",
    });
  });

  it("redirects provider errors to the auth error page", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/google/callback?error=access_denied"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://app.test/auth/error?code=access_denied");
    expect(mockSaveGoogleWorkspaceCredentialFromAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects callbacks when the signed state user differs from the current session", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "user-other" });

    const response = await GET(new Request("http://localhost/api/integrations/google/callback?code=code-1&state=state-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://app.test/w/workspace-alpha/im?googleWorkspaceError=google_workspace.unauthorized",
    );
    expect(mockSaveGoogleWorkspaceCredentialFromAuthorizationCode).not.toHaveBeenCalled();
  });
});
