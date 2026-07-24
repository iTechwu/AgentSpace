import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireCurrentWorkspaceContext } = vi.hoisted(() => ({
  mockRequireCurrentWorkspaceContext: vi.fn(),
}));

const { mockGetCurrentSession } = vi.hoisted(() => ({
  mockGetCurrentSession: vi.fn(),
}));

const {
  mockCreateWorkspaceInvitationSync,
  mockCreateNotificationSync,
  mockAddHumanMemberSync,
  mockListWorkspaceMemberUsersSync,
  mockListWorkspaceInvitationsSync,
  mockRevalidatePath,
  mockReadUserByEmailSync,
  mockReadDaemonApiTokenSync,
  mockReadAuthIdentityForUserSync,
  mockRevokeOtherSessionsForUserSync,
  mockRevokeDaemonApiTokenSync,
  mockRevokeWorkspaceInvitationSync,
  mockRemoveWorkspaceMembershipSync,
  mockRevokeSessionByIdSync,
  mockRotateWorkspaceJoinCodeSync,
  mockTransferWorkspaceOwnershipSync,
  mockTryRecordWorkspaceAuditEventSync,
  mockUpdateUserSync,
  mockUpdateWorkspaceMembershipRoleSync,
  mockUpdateWorkspaceSync,
  mockUpsertWorkspaceMembershipSync,
} = vi.hoisted(() => ({
  mockCreateWorkspaceInvitationSync: vi.fn(),
  mockCreateNotificationSync: vi.fn(),
  mockAddHumanMemberSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockListWorkspaceInvitationsSync: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockReadUserByEmailSync: vi.fn(),
  mockReadDaemonApiTokenSync: vi.fn(),
  mockReadAuthIdentityForUserSync: vi.fn(),
  mockRevokeOtherSessionsForUserSync: vi.fn(),
  mockRevokeDaemonApiTokenSync: vi.fn(),
  mockRevokeWorkspaceInvitationSync: vi.fn(),
  mockRemoveWorkspaceMembershipSync: vi.fn(),
  mockRevokeSessionByIdSync: vi.fn(),
  mockRotateWorkspaceJoinCodeSync: vi.fn(),
  mockTransferWorkspaceOwnershipSync: vi.fn(),
  mockTryRecordWorkspaceAuditEventSync: vi.fn(),
  mockUpdateUserSync: vi.fn(),
  mockUpdateWorkspaceMembershipRoleSync: vi.fn(),
  mockUpdateWorkspaceSync: vi.fn(),
  mockUpsertWorkspaceMembershipSync: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/server-auth", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@agent-space/db", () => ({
  createDaemonApiTokenSync: vi.fn(),
  createWorkspaceInvitationSync: mockCreateWorkspaceInvitationSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
  listWorkspaceInvitationsSync: mockListWorkspaceInvitationsSync,
  readUserByEmailSync: mockReadUserByEmailSync,
  readAuthIdentityForUserSync: mockReadAuthIdentityForUserSync,
  readDaemonApiTokenSync: mockReadDaemonApiTokenSync,
  revokeOtherSessionsForUserSync: mockRevokeOtherSessionsForUserSync,
  revokeDaemonApiTokenSync: mockRevokeDaemonApiTokenSync,
  revokeWorkspaceInvitationSync: mockRevokeWorkspaceInvitationSync,
  removeWorkspaceMembershipSync: mockRemoveWorkspaceMembershipSync,
  revokeSessionByIdSync: mockRevokeSessionByIdSync,
  rotateWorkspaceJoinCodeSync: mockRotateWorkspaceJoinCodeSync,
  transferWorkspaceOwnershipSync: mockTransferWorkspaceOwnershipSync,
  updateUserSync: mockUpdateUserSync,
  updateWorkspaceMembershipRoleSync: mockUpdateWorkspaceMembershipRoleSync,
  updateWorkspaceSync: mockUpdateWorkspaceSync,
  upsertWorkspaceMembershipSync: mockUpsertWorkspaceMembershipSync,
}));

vi.mock("@agent-space/services", () => ({
  addHumanMemberSync: mockAddHumanMemberSync,
  createNotificationSync: mockCreateNotificationSync,
  tryRecordWorkspaceAuditEventSync: mockTryRecordWorkspaceAuditEventSync,
}));

import {
  addWorkspaceMemberAction,
  createWorkspaceInvitationAction,
  removeWorkspaceMemberAction,
  reissueWorkspaceInvitationAction,
  revokeDaemonApiTokenAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  revokeWorkspaceInvitationAction,
  transferWorkspaceOwnershipAction,
  updateCurrentUserProfileAction,
  updateWorkspaceMemberRoleAction,
  updateWorkspaceProfileAction,
} from "./actions";

describe("settings actions", () => {
  beforeEach(() => {
    mockRequireCurrentWorkspaceContext.mockReset();
    mockGetCurrentSession.mockReset();
    mockCreateWorkspaceInvitationSync.mockReset();
    mockCreateNotificationSync.mockReset();
    mockAddHumanMemberSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockListWorkspaceInvitationsSync.mockReset();
    mockReadUserByEmailSync.mockReset();
    mockReadDaemonApiTokenSync.mockReset();
    mockReadAuthIdentityForUserSync.mockReset();
    mockRevokeOtherSessionsForUserSync.mockReset();
    mockRevokeDaemonApiTokenSync.mockReset();
    mockRevokeWorkspaceInvitationSync.mockReset();
    mockRemoveWorkspaceMembershipSync.mockReset();
    mockRevokeSessionByIdSync.mockReset();
    mockRotateWorkspaceJoinCodeSync.mockReset();
    mockTransferWorkspaceOwnershipSync.mockReset();
    mockTryRecordWorkspaceAuditEventSync.mockReset();
    mockUpdateUserSync.mockReset();
    mockUpdateWorkspaceMembershipRoleSync.mockReset();
    mockUpdateWorkspaceSync.mockReset();
    mockUpsertWorkspaceMembershipSync.mockReset();
    mockReadAuthIdentityForUserSync.mockReturnValue(null);
    mockRevalidatePath.mockReset();

    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
    mockGetCurrentSession.mockResolvedValue({
      id: "session-current",
      userId: "user-1",
      tokenHash: "hash",
      createdAt: "2026-04-22T00:00:00.000Z",
      lastSeenAt: "2026-04-22T00:00:00.000Z",
      expiresAt: "2026-05-22T00:00:00.000Z",
    });
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      {
        userId: "user-1",
        displayName: "Mina",
        primaryEmail: "mina@example.com",
        role: "owner",
      },
      {
        userId: "user-2",
        displayName: "Alex",
        primaryEmail: "alex@example.com",
        role: "member",
      },
    ]);
    mockListWorkspaceInvitationsSync.mockReturnValue([
      {
        id: "invite-1",
        workspaceId: "workspace-mars",
        email: "invitee@example.com",
        role: "member",
        tokenHash: "hash",
        status: "active",
        invitedBy: "user-1",
        createdAt: "2026-04-22T00:00:00.000Z",
        expiresAt: "2026-04-29T00:00:00.000Z",
      },
    ]);
  });

  it("rejects revoking daemon tokens from another workspace", async () => {
    mockReadDaemonApiTokenSync.mockReturnValue({
      id: "token-1",
      workspaceId: "workspace-other",
    });

    await expect(revokeDaemonApiTokenAction("token-1")).rejects.toThrow("Forbidden.");
    expect(mockRevokeDaemonApiTokenSync).not.toHaveBeenCalled();
  });

  it("rejects members from revoking daemon tokens", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(revokeDaemonApiTokenAction("token-1")).rejects.toThrow("Forbidden.");
    expect(mockRevokeDaemonApiTokenSync).not.toHaveBeenCalled();
  });

  it("revokes daemon tokens in the current workspace", async () => {
    mockReadDaemonApiTokenSync.mockReturnValue({
      id: "token-1",
      workspaceId: "workspace-mars",
    });

    await revokeDaemonApiTokenAction("token-1");

    expect(mockRevokeDaemonApiTokenSync).toHaveBeenCalledWith("token-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects revoking the current session", async () => {
    await expect(revokeSessionAction("session-current")).rejects.toThrow("Cannot revoke the current session.");
    expect(mockRevokeSessionByIdSync).not.toHaveBeenCalled();
  });

  it("revokes another session that belongs to the current user", async () => {
    mockRevokeSessionByIdSync.mockReturnValue(true);

    await revokeSessionAction("session-other");

    expect(mockRevokeSessionByIdSync).toHaveBeenCalledWith("session-other", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("revokes other sessions for the current user", async () => {
    mockRevokeOtherSessionsForUserSync.mockReturnValue(2);

    await expect(revokeOtherSessionsAction()).resolves.toEqual({ revokedCount: 2 });

    expect(mockRevokeOtherSessionsForUserSync).toHaveBeenCalledWith("user-1", "session-current");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("adds an existing user to the workspace", async () => {
    mockReadUserByEmailSync.mockReturnValue({
      id: "user-3",
      displayName: "Taylor",
      primaryEmail: "taylor@example.com",
    });
    mockUpsertWorkspaceMembershipSync.mockReturnValue({
      id: "membership-3",
      workspaceId: "workspace-mars",
      userId: "user-3",
      role: "admin",
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    });

    await addWorkspaceMemberAction({
      email: "taylor@example.com",
      role: "admin",
    });

    expect(mockUpsertWorkspaceMembershipSync).toHaveBeenCalledWith({
      workspaceId: "workspace-mars",
      userId: "user-3",
      role: "admin",
      invitedBy: "user-1",
    });
    expect(mockCreateNotificationSync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-mars",
      recipientType: "human",
      recipientId: "user-3",
      type: "workspace.member_added",
    }));
  });

  it("rejects local workspace membership writes for SSO-managed workspaces", async () => {
    const ssoWorkspaceContext = buildWorkspaceContext();
    ssoWorkspaceContext.currentWorkspace.id = "sso-team-mars";
    ssoWorkspaceContext.currentMembership.workspaceId = "sso-team-mars";
    mockRequireCurrentWorkspaceContext.mockResolvedValue(ssoWorkspaceContext);

    await expect(addWorkspaceMemberAction({
      email: "taylor@example.com",
      role: "member",
    })).rejects.toThrow("auth.sso_workspace_managed");

    expect(mockReadUserByEmailSync).not.toHaveBeenCalled();
    expect(mockUpsertWorkspaceMembershipSync).not.toHaveBeenCalled();
  });

  it("creates a workspace invitation", async () => {
    mockCreateWorkspaceInvitationSync.mockReturnValue({
      id: "invite-2",
      workspaceId: "workspace-mars",
      email: "invitee@example.com",
      role: "member",
      tokenHash: "hash",
      status: "active",
      invitedBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      expiresAt: "2026-04-29T00:00:00.000Z",
      token: "wsi_test",
    });

    await expect(createWorkspaceInvitationAction({
      email: "invitee@example.com",
      role: "member",
    })).resolves.toEqual({
      id: "invite-2",
      email: "invitee@example.com",
      role: "member",
      createdAt: "2026-04-22T00:00:00.000Z",
      expiresAt: "2026-04-29T00:00:00.000Z",
      invitePath: "/invite/wsi_test",
    });
  });

  it("reissues an existing workspace invitation", async () => {
    mockCreateWorkspaceInvitationSync.mockReturnValue({
      id: "invite-2",
      workspaceId: "workspace-mars",
      email: "invitee@example.com",
      role: "member",
      tokenHash: "hash",
      status: "active",
      invitedBy: "user-1",
      createdAt: "2026-04-25T00:00:00.000Z",
      expiresAt: "2026-05-02T00:00:00.000Z",
      token: "wsi_reissued",
    });

    await expect(reissueWorkspaceInvitationAction("invite-1")).resolves.toEqual({
      id: "invite-2",
      email: "invitee@example.com",
      role: "member",
      createdAt: "2026-04-25T00:00:00.000Z",
      expiresAt: "2026-05-02T00:00:00.000Z",
      invitePath: "/invite/wsi_reissued",
    });
  });

  it("revokes a workspace invitation", async () => {
    mockRevokeWorkspaceInvitationSync.mockReturnValue(true);

    await revokeWorkspaceInvitationAction("invite-1");

    expect(mockRevokeWorkspaceInvitationSync).toHaveBeenCalledWith("invite-1", "workspace-mars");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("prevents admins from assigning owner role", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await expect(addWorkspaceMemberAction({
      email: "taylor@example.com",
      role: "owner",
    })).rejects.toThrow("workspace.members.owner_only");
  });

  it("prevents admins from changing an owner", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      {
        userId: "user-1",
        displayName: "Mina",
        primaryEmail: "mina@example.com",
        role: "admin",
      },
      {
        userId: "user-2",
        displayName: "Alex",
        primaryEmail: "alex@example.com",
        role: "owner",
      },
    ]);

    await expect(updateWorkspaceMemberRoleAction({
      userId: "user-2",
      role: "member",
    })).rejects.toThrow("workspace.members.owner_only");
  });

  it("prevents removing the last owner", async () => {
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      {
        userId: "user-1",
        displayName: "Mina",
        primaryEmail: "mina@example.com",
        role: "owner",
      },
      {
        userId: "user-2",
        displayName: "Alex",
        primaryEmail: "alex@example.com",
        role: "owner",
      },
    ]);

    await removeWorkspaceMemberAction("user-2");
    expect(mockRemoveWorkspaceMembershipSync).toHaveBeenCalledWith("workspace-mars", "user-2");

    mockRemoveWorkspaceMembershipSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      {
        userId: "user-1",
        displayName: "Mina",
        primaryEmail: "mina@example.com",
        role: "owner",
      },
    ]);

    await expect(removeWorkspaceMemberAction("user-1")).rejects.toThrow("workspace.members.cannot_manage_self");
  });

  it("allows owners to update workspace profile", async () => {
    await updateWorkspaceProfileAction({ name: "Mars Foundry" });

    expect(mockUpdateWorkspaceSync).toHaveBeenCalledWith("workspace-mars", {
      name: "Mars Foundry",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("allows the current user to update their display name", async () => {
    await updateCurrentUserProfileAction({ displayName: "Mina Chen" });

    expect(mockUpdateUserSync).toHaveBeenCalledWith({
      userId: "user-1",
      displayName: "Mina Chen",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects admins from updating workspace profile", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await expect(updateWorkspaceProfileAction({ name: "Mars Foundry" })).rejects.toThrow("Forbidden.");
    expect(mockUpdateWorkspaceSync).not.toHaveBeenCalled();
  });

  it("transfers ownership from the current owner to another member", async () => {
    await transferWorkspaceOwnershipAction("user-2");

    expect(mockTransferWorkspaceOwnershipSync).toHaveBeenCalledWith("workspace-mars", "user-1", "user-2");
    expect(mockCreateNotificationSync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-mars",
      recipientType: "human",
      recipientId: "user-2",
      type: "workspace.ownership_transferred.new_owner",
    }));
    expect(mockCreateNotificationSync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-mars",
      recipientType: "human",
      recipientId: "user-1",
      type: "workspace.ownership_transferred.previous_owner",
    }));
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects admins from transferring ownership", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await expect(transferWorkspaceOwnershipAction("user-2")).rejects.toThrow("Forbidden.");
    expect(mockTransferWorkspaceOwnershipSync).not.toHaveBeenCalled();
  });
});

function buildWorkspaceContext(role: "owner" | "admin" | "member" = "owner") {
  return {
    currentUser: {
      id: "user-1",
      organizationName: "Mars Labs",
      displayName: "Mina",
      role,
      email: "mina@example.com",
    },
    currentWorkspace: {
      id: "workspace-mars",
      slug: "workspace-mars",
      name: "Mars Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-mars",
      workspaceId: "workspace-mars",
      userId: "user-1",
      role,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}
