import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateDaemonApiTokenSync,
  mockReadDaemonApiTokenSync,
  mockRevokeDaemonApiTokenSync,
  mockRevokeOtherSessionsForUserSync,
  mockRevokeSessionByIdSync,
  mockIsPlatformAdminUserSync,
  mockListWorkspaceMemberUsersSync,
  mockTransferWorkspaceOwnershipSync,
} = vi.hoisted(() => ({
  mockCreateDaemonApiTokenSync: vi.fn(),
  mockReadDaemonApiTokenSync: vi.fn(),
  mockRevokeDaemonApiTokenSync: vi.fn(),
  mockRevokeOtherSessionsForUserSync: vi.fn(),
  mockRevokeSessionByIdSync: vi.fn(),
  mockIsPlatformAdminUserSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockTransferWorkspaceOwnershipSync: vi.fn(),
}));

const { mockTransferSsoWorkspaceOwnership } = vi.hoisted(() => ({
  mockTransferSsoWorkspaceOwnership: vi.fn(),
}));

const { mockRequireCurrentWorkspaceContext, mockGetCurrentSession } = vi.hoisted(() => ({
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockGetCurrentSession: vi.fn(),
}));

const { mockRevalidateWorkspacePaths, mockTryRecordWorkspaceAuditEventSync } = vi.hoisted(() => ({
  mockRevalidateWorkspacePaths: vi.fn(),
  mockTryRecordWorkspaceAuditEventSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  createDaemonApiTokenSync: mockCreateDaemonApiTokenSync,
  readDaemonApiTokenSync: mockReadDaemonApiTokenSync,
  revokeDaemonApiTokenSync: mockRevokeDaemonApiTokenSync,
  revokeOtherSessionsForUserSync: mockRevokeOtherSessionsForUserSync,
  revokeSessionByIdSync: mockRevokeSessionByIdSync,
  isPlatformAdminUserSync: mockIsPlatformAdminUserSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
  transferWorkspaceOwnershipSync: mockTransferWorkspaceOwnershipSync,
}));

vi.mock("@/features/auth/sso-workspace-ownership", () => ({
  transferSsoWorkspaceOwnership: mockTransferSsoWorkspaceOwnership,
}));

vi.mock("@dofe-agent/services", () => ({
  tryRecordWorkspaceAuditEventSync: mockTryRecordWorkspaceAuditEventSync,
}));

vi.mock("@/features/auth/server-auth", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

import {
  createDaemonApiTokenAction,
  revokeDaemonApiTokenAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  transferWorkspaceOwnershipAction,
} from "./actions";

describe("settings actions", () => {
  beforeEach(() => {
    mockCreateDaemonApiTokenSync.mockReset();
    mockReadDaemonApiTokenSync.mockReset();
    mockRevokeDaemonApiTokenSync.mockReset();
    mockRevokeOtherSessionsForUserSync.mockReset();
    mockRevokeSessionByIdSync.mockReset();
    mockIsPlatformAdminUserSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockTransferWorkspaceOwnershipSync.mockReset();
    mockTransferSsoWorkspaceOwnership.mockReset();
    mockTryRecordWorkspaceAuditEventSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockGetCurrentSession.mockResolvedValue({ id: "session-current" });
    mockIsPlatformAdminUserSync.mockReturnValue(false);
    mockTransferSsoWorkspaceOwnership.mockResolvedValue(undefined);
  });

  it("creates an admin-scoped daemon token", async () => {
    mockCreateDaemonApiTokenSync.mockReturnValue({
      id: "token-1",
      label: "Claude daemon",
      token: "dofe_secret",
    });

    await expect(createDaemonApiTokenAction({
      label: " Claude daemon ",
      createdBy: "Mina",
    })).resolves.toMatchObject({
      data: { id: "token-1", label: "Claude daemon", token: "dofe_secret" },
    });

    expect(mockCreateDaemonApiTokenSync).toHaveBeenCalledWith({
      workspaceId: "workspace-mars",
      label: "Claude daemon",
      createdBy: "Mina",
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalled();
  });

  it("does not revoke a daemon token from another workspace", async () => {
    mockReadDaemonApiTokenSync.mockReturnValue({ id: "token-1", workspaceId: "workspace-other" });

    await expect(revokeDaemonApiTokenAction("token-1")).rejects.toThrow("Forbidden.");
    expect(mockRevokeDaemonApiTokenSync).not.toHaveBeenCalled();
  });

  it("revokes a daemon token in the current workspace", async () => {
    mockReadDaemonApiTokenSync.mockReturnValue({ id: "token-1", workspaceId: "workspace-mars" });

    await revokeDaemonApiTokenAction("token-1");

    expect(mockRevokeDaemonApiTokenSync).toHaveBeenCalledWith("token-1");
    expect(mockTryRecordWorkspaceAuditEventSync).toHaveBeenCalledWith(expect.objectContaining({
      code: "workspace.daemon_token_revoked",
    }));
  });

  it("does not revoke the current session", async () => {
    await expect(revokeSessionAction("session-current")).rejects.toThrow("Cannot revoke the current session.");
    expect(mockRevokeSessionByIdSync).not.toHaveBeenCalled();
  });

  it("revokes another session owned by the current user", async () => {
    mockRevokeSessionByIdSync.mockReturnValue(true);

    await revokeSessionAction("session-other");

    expect(mockRevokeSessionByIdSync).toHaveBeenCalledWith("session-other", "user-1");
  });

  it("revokes the current user's other sessions", async () => {
    mockRevokeOtherSessionsForUserSync.mockReturnValue(2);

    await expect(revokeOtherSessionsAction()).resolves.toEqual({ revokedCount: 2 });
    expect(mockRevokeOtherSessionsForUserSync).toHaveBeenCalledWith("user-1", "session-current");
  });
});

describe("transferWorkspaceOwnershipAction", () => {
  beforeEach(() => {
    mockRequireCurrentWorkspaceContext.mockReset();
    mockIsPlatformAdminUserSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockTransferWorkspaceOwnershipSync.mockReset();
    mockTransferSsoWorkspaceOwnership.mockReset();
    mockTryRecordWorkspaceAuditEventSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockIsPlatformAdminUserSync.mockReturnValue(false);
    mockTransferSsoWorkspaceOwnership.mockResolvedValue(undefined);
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      { userId: "user-2", displayName: "Cara", role: "member" },
      { userId: "user-3", displayName: "Bo", role: "admin" },
    ]);
  });

  it("writes to SSO first, then mirrors locally, then audits (owner)", async () => {
    await transferWorkspaceOwnershipAction({ targetUserId: "user-2" });

    expect(mockTransferSsoWorkspaceOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-mars",
        currentOwnerUserId: "user-1",
        nextOwnerUserId: "user-2",
      }),
    );
    expect(mockTransferSsoWorkspaceOwnership).toHaveBeenCalledBefore(
      mockTransferWorkspaceOwnershipSync,
    );
    expect(mockTransferWorkspaceOwnershipSync).toHaveBeenCalledWith("workspace-mars", "user-1", "user-2");
    expect(mockTryRecordWorkspaceAuditEventSync).toHaveBeenCalledWith(
      expect.objectContaining({ code: "workspace.ownership_transferred" }),
    );
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalled();
  });

  it("rejects admin actors (owner-only)", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-2" })).rejects.toThrow("Forbidden.");
    expect(mockTransferSsoWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("rejects member actors (owner-only)", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-2" })).rejects.toThrow("Forbidden.");
    expect(mockTransferSsoWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("rejects transferring to self", async () => {
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-1" })).rejects.toThrow("yourself");
    expect(mockTransferSsoWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("rejects a platform-admin target", async () => {
    mockIsPlatformAdminUserSync.mockReturnValue(true);
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-pa" })).rejects.toThrow(
      "workspace.members.transfer_target_is_platform_admin",
    );
    expect(mockTransferSsoWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("rejects a target that is not a workspace member", async () => {
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-ghost" })).rejects.toThrow(
      "workspace.members.transfer_target_missing",
    );
    expect(mockTransferSsoWorkspaceOwnership).not.toHaveBeenCalled();
  });

  it("does not mirror locally or audit when the SSO write fails", async () => {
    mockTransferSsoWorkspaceOwnership.mockRejectedValue(new Error("boom"));
    await expect(transferWorkspaceOwnershipAction({ targetUserId: "user-2" })).rejects.toThrow("boom");
    expect(mockTransferWorkspaceOwnershipSync).not.toHaveBeenCalled();
    expect(mockTryRecordWorkspaceAuditEventSync).not.toHaveBeenCalled();
  });
});

function buildWorkspaceContext(role: "owner" | "admin" | "member" = "owner") {
  return {
    currentUser: {
      id: "user-1",
      displayName: "Mina",
    },
    currentWorkspace: {
      id: "workspace-mars",
      slug: "mars-labs",
    },
    currentMembership: { role },
  };
}
