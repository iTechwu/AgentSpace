import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateGoogleDriveFilePermission,
  mockDeleteGoogleDriveFilePermission,
  mockListGoogleDriveFilePermissions,
  mockListChannelDocumentAccessesSync,
  mockListWorkspaceMemberUsersSync,
  mockReadChannelDocumentSync,
  mockRecordExternalSheetOperationRunSync,
  mockUpdateExternalSheetOperationRunSync,
  mockUpdateGoogleDriveFilePermission,
} = vi.hoisted(() => ({
  mockCreateGoogleDriveFilePermission: vi.fn(),
  mockDeleteGoogleDriveFilePermission: vi.fn(),
  mockListGoogleDriveFilePermissions: vi.fn(),
  mockListChannelDocumentAccessesSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockReadChannelDocumentSync: vi.fn(),
  mockRecordExternalSheetOperationRunSync: vi.fn(),
  mockUpdateExternalSheetOperationRunSync: vi.fn(),
  mockUpdateGoogleDriveFilePermission: vi.fn(),
}));

vi.mock("@agent-space/db", () => ({
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
}));

vi.mock("@agent-space/services", () => ({
  listChannelDocumentAccessesSync: mockListChannelDocumentAccessesSync,
  readChannelDocumentSync: mockReadChannelDocumentSync,
  recordExternalSheetOperationRunSync: mockRecordExternalSheetOperationRunSync,
  updateExternalSheetOperationRunSync: mockUpdateExternalSheetOperationRunSync,
}));

vi.mock("@/features/integrations/google-workspace", () => ({
  createGoogleDriveFilePermission: mockCreateGoogleDriveFilePermission,
  deleteGoogleDriveFilePermission: mockDeleteGoogleDriveFilePermission,
  listGoogleDriveFilePermissions: mockListGoogleDriveFilePermissions,
  updateGoogleDriveFilePermission: mockUpdateGoogleDriveFilePermission,
}));

import { syncGoogleSheetDocumentDrivePermissions } from "./google-drive-permissions";

describe("Google Drive permission sync", () => {
  beforeEach(() => {
    mockCreateGoogleDriveFilePermission.mockReset();
    mockDeleteGoogleDriveFilePermission.mockReset();
    mockListGoogleDriveFilePermissions.mockReset();
    mockListChannelDocumentAccessesSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockReadChannelDocumentSync.mockReset();
    mockRecordExternalSheetOperationRunSync.mockReset();
    mockUpdateExternalSheetOperationRunSync.mockReset();
    mockUpdateGoogleDriveFilePermission.mockReset();

    mockReadChannelDocumentSync.mockReturnValue({
      document: {
        id: "doc-1",
        externalFileId: "sheet-1",
      },
    });
    mockRecordExternalSheetOperationRunSync.mockReturnValue({
      id: "run-1",
    });
    mockUpdateExternalSheetOperationRunSync.mockImplementation((input: {
      runId: string;
      status: "succeeded" | "failed";
      responseSummary?: string;
      errorMessage?: string;
    }) => ({
      id: input.runId,
      status: input.status,
      responseSummary: input.responseSummary,
      errorMessage: input.errorMessage,
    }));
    mockCreateGoogleDriveFilePermission.mockResolvedValue({
      id: "permission-1",
      type: "user",
      role: "writer",
      emailAddress: "mina@example.com",
    });
    mockDeleteGoogleDriveFilePermission.mockResolvedValue(undefined);
    mockListGoogleDriveFilePermissions.mockResolvedValue([]);
    mockUpdateGoogleDriveFilePermission.mockResolvedValue({
      id: "permission-1",
      type: "user",
      role: "writer",
      emailAddress: "mina@example.com",
    });
  });

  it("shares external sheet files with human collaborators that have workspace emails", async () => {
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      { userId: "user-1", displayName: "techwu", primaryEmail: "techwu@example.com", role: "owner" },
      { userId: "user-2", displayName: "Mina", primaryEmail: "mina@example.com", role: "member" },
      { userId: "user-3", displayName: "Alex", role: "member" },
    ]);
    mockListChannelDocumentAccessesSync.mockReturnValue([
      { documentId: "doc-1", actorId: "techwu", actorType: "human", role: "owner" },
      { documentId: "doc-1", actorId: "Mina", actorType: "human", role: "editor" },
      { documentId: "doc-1", actorId: "Alex", actorType: "human", role: "viewer" },
      { documentId: "doc-1", actorId: "Atlas", actorType: "agent", role: "editor" },
    ]);

    const result = await syncGoogleSheetDocumentDrivePermissions({
      accessToken: "access-token",
      workspaceId: "workspace-1",
      documentId: "doc-1",
      actorId: "techwu",
      actorType: "human",
      skipEmails: ["techwu@example.com"],
    });

    expect(result).toMatchObject({
      status: "succeeded",
      sharedCount: 1,
      skippedCount: 3,
      failedCount: 0,
    });
    expect(mockCreateGoogleDriveFilePermission).toHaveBeenCalledTimes(1);
    expect(mockCreateGoogleDriveFilePermission).toHaveBeenCalledWith({
      accessToken: "access-token",
      fileId: "sheet-1",
      emailAddress: "mina@example.com",
      role: "writer",
      sendNotificationEmail: false,
    });
    expect(mockRecordExternalSheetOperationRunSync).toHaveBeenCalledWith({
      channelDocumentId: "doc-1",
      actorType: "human",
      actorId: "techwu",
      status: "running",
      intent: "Sync Google Drive permissions for external sheet",
      operationType: "share",
      requestSummary: "Sync Drive permissions for 1 collaborator(s); skipped 3.",
    }, "workspace-1");
    expect(mockUpdateExternalSheetOperationRunSync).toHaveBeenCalledWith({
      runId: "run-1",
      status: "succeeded",
      responseSummary: "Shared 1; updated 0; revoked 0; skipped 3; failed 0.",
    }, "workspace-1");
  });

  it("records a failed share run when one collaborator permission fails", async () => {
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      { userId: "user-2", displayName: "Mina", primaryEmail: "mina@example.com", role: "member" },
      { userId: "user-3", displayName: "Alex", primaryEmail: "alex@example.com", role: "member" },
    ]);
    mockListChannelDocumentAccessesSync.mockReturnValue([
      { documentId: "doc-1", actorId: "Mina", actorType: "human", role: "editor" },
      { documentId: "doc-1", actorId: "Alex", actorType: "human", role: "viewer" },
    ]);
    mockCreateGoogleDriveFilePermission
      .mockResolvedValueOnce({ id: "permission-1", type: "user", role: "writer", emailAddress: "mina@example.com" })
      .mockRejectedValueOnce(new Error("Google Drive permission create failed."));

    const result = await syncGoogleSheetDocumentDrivePermissions({
      accessToken: "access-token",
      workspaceId: "workspace-1",
      documentId: "doc-1",
      actorId: "system",
    });

    expect(result).toMatchObject({
      status: "failed",
      sharedCount: 1,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(mockCreateGoogleDriveFilePermission).toHaveBeenNthCalledWith(2, {
      accessToken: "access-token",
      fileId: "sheet-1",
      emailAddress: "alex@example.com",
      role: "reader",
      sendNotificationEmail: false,
    });
    expect(mockUpdateExternalSheetOperationRunSync).toHaveBeenCalledWith({
      runId: "run-1",
      status: "failed",
      responseSummary: "Shared 1; updated 0; revoked 0; skipped 0; failed 1.",
      errorCode: "google_workspace.permission_sync_failed",
      errorMessage: "alex@example.com: Google Drive permission create failed.",
    }, "workspace-1");
  });
});
