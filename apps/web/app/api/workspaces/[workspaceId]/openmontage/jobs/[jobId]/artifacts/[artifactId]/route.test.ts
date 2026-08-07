import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  canRead: vi.fn(),
  readLink: vi.fn(),
  readBinding: vi.fn(),
  readProjection: vi.fn(),
  readArtifact: vi.fn(),
  readBlob: vi.fn(),
  createStorage: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({ getWorkspaceAccessForIdentifier: mocks.access }));
vi.mock("@dofe-agent/db", () => ({
  readOpenMontageJobLinkSync: mocks.readLink,
  readOpenMontageChatBindingSync: mocks.readBinding,
  readOpenMontageJobProjectionSync: mocks.readProjection,
  readEmployeeArtifactSync: mocks.readArtifact,
  readContentBlobSync: mocks.readBlob,
}));
vi.mock("@dofe-agent/services", () => ({
  canReadChannelForActorSync: mocks.canRead,
  createAttachmentStorageClient: mocks.createStorage,
}));

import { GET } from "./route";

describe("OpenMontage published artifact route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ status: "ok", context: workspaceContext() });
    mocks.canRead.mockReturnValue(true);
    mocks.readLink.mockReturnValue({
      workspaceId: "workspace-1", employeeId: "employee-1", rootTaskId: "task-1",
    });
    mocks.readBinding.mockReturnValue({ workspaceId: "workspace-1", channelName: "direct:employee-1" });
    mocks.readProjection.mockReturnValue({ artifacts: [{ artifactId: "eart-1", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }] });
    mocks.readArtifact.mockReturnValue({
      id: "eart-1", employeeId: "employee-1", sourceTaskId: "task-1", fileName: "final.mp4",
      mediaType: "video/mp4", sizeBytes: 5, contentDigest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    mocks.readBlob.mockReturnValue({
      storageProvider: "local", storageKey: "blob-key", sizeBytes: 5,
    });
    mocks.createStorage.mockReturnValue({
      createReadUrl: vi.fn().mockResolvedValue(null),
      getContentAddressedBlobSync: vi.fn().mockReturnValue(Buffer.from("hello")),
    });
  });

  it("serves an authorized final MP4 with byte ranges", async () => {
    const response = await GET(new Request("http://localhost/artifact", { headers: { Range: "bytes=1-3" } }), params());

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("ell");
    expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(response.headers.get("content-type")).toBe("video/mp4");
  });

  it("does not expose an artifact outside the Job channel or immutable manifest", async () => {
    mocks.canRead.mockReturnValue(false);
    expect((await GET(new Request("http://localhost/artifact"), params())).status).toBe(403);

    mocks.canRead.mockReturnValue(true);
    mocks.readProjection.mockReturnValue({ artifacts: [] });
    expect((await GET(new Request("http://localhost/artifact"), params())).status).toBe(404);
  });
});

function params() {
  return { params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1", artifactId: "eart-1" }) };
}

function workspaceContext() {
  return {
    currentUser: { id: "user-1", displayName: "Tech Wu" },
    currentWorkspace: { id: "workspace-1" },
    currentMembership: { role: "member" },
  };
}
