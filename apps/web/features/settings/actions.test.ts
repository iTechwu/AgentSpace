import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateDaemonApiTokenSync,
  mockReadDaemonApiTokenSync,
  mockRevokeDaemonApiTokenSync,
  mockRevokeOtherSessionsForUserSync,
  mockRevokeSessionByIdSync,
} = vi.hoisted(() => ({
  mockCreateDaemonApiTokenSync: vi.fn(),
  mockReadDaemonApiTokenSync: vi.fn(),
  mockRevokeDaemonApiTokenSync: vi.fn(),
  mockRevokeOtherSessionsForUserSync: vi.fn(),
  mockRevokeSessionByIdSync: vi.fn(),
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
} from "./actions";

describe("settings actions", () => {
  beforeEach(() => {
    mockCreateDaemonApiTokenSync.mockReset();
    mockReadDaemonApiTokenSync.mockReset();
    mockRevokeDaemonApiTokenSync.mockReset();
    mockRevokeOtherSessionsForUserSync.mockReset();
    mockRevokeSessionByIdSync.mockReset();
    mockTryRecordWorkspaceAuditEventSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockGetCurrentSession.mockResolvedValue({ id: "session-current" });
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
