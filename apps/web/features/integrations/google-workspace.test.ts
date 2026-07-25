import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleDriveFilePermission,
  GoogleWorkspaceApiError,
  readGoogleDriveFileMetadata,
} from "./google-workspace";

describe("Google Workspace API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("creates Google Drive user permissions without sending email notifications", async () => {
    vi.stubEnv("DOFE_AGENT_GOOGLE_WORKSPACE_EXECUTOR", "api");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "permission-1",
        type: "user",
        role: "writer",
        emailAddress: "mina@example.com",
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGoogleDriveFilePermission({
      accessToken: "access-token",
      fileId: "sheet-1",
      emailAddress: "Mina@Example.com",
      role: "writer",
    });

    expect(result).toEqual({
      id: "permission-1",
      type: "user",
      role: "writer",
      emailAddress: "mina@example.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/drive/v3/files/sheet-1/permissions?fields=id%2Ctype%2Crole%2CemailAddress&sendNotificationEmail=false",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "user",
          role: "writer",
          emailAddress: "mina@example.com",
        }),
        cache: "no-store",
      },
    );
  });

  it("wraps failed Drive permission responses with a Google Workspace error code", async () => {
    vi.stubEnv("DOFE_AGENT_GOOGLE_WORKSPACE_EXECUTOR", "api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          message: "Insufficient Permission",
        },
      }), { status: 403 }),
    ));

    await expect(createGoogleDriveFilePermission({
      accessToken: "access-token",
      fileId: "sheet-1",
      emailAddress: "mina@example.com",
      role: "reader",
    })).rejects.toMatchObject({
      name: "GoogleWorkspaceApiError",
      status: 403,
      code: "google_workspace.drive_permission_failed",
      message: "Google Drive permission create failed. Insufficient Permission",
    } satisfies Partial<GoogleWorkspaceApiError>);
  });

  it("explains OAuth visibility when Drive metadata returns 404", async () => {
    vi.stubEnv("DOFE_AGENT_GOOGLE_WORKSPACE_EXECUTOR", "api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          message: "File not found",
        },
      }), { status: 404 }),
    ));

    let caught: unknown;
    try {
      await readGoogleDriveFileMetadata({
        accessToken: "access-token",
        fileId: "sheet-1",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "GoogleWorkspaceApiError",
      status: 404,
      code: "google_workspace.drive_metadata_failed",
    } satisfies Partial<GoogleWorkspaceApiError>);
    expect(caught).toBeInstanceOf(GoogleWorkspaceApiError);
    expect((caught as GoogleWorkspaceApiError).message).toContain("The current OAuth client/scope cannot see this file");
    expect((caught as GoogleWorkspaceApiError).message).toMatch(/drive\.file/);
  });
});
