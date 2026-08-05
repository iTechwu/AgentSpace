import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolve, mockPublish, AuthenticationError, ValidationError, GrantError } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockPublish: vi.fn(),
  AuthenticationError: class extends Error {},
  ValidationError: class extends Error {},
  GrantError: class extends Error {},
}));

vi.mock("@dofe-agent/services", () => ({
  resolveOpenMontageArtifactReadDownload: mockResolve,
  publishOpenMontageArtifactUpload: mockPublish,
  OpenMontageArtifactAuthenticationError: AuthenticationError,
  OpenMontageArtifactValidationError: ValidationError,
}));

vi.mock("@dofe-agent/db", () => ({
  OpenMontageArtifactGrantError: GrantError,
}));

import { GET, PUT } from "./route";

const attachment = {
  id: "att-video-1",
  fileName: "reference.mp4",
  mediaType: "video/mp4",
  sizeBytes: 5,
  sha256: "a".repeat(64),
};

describe("OpenMontage artifact grant download route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects a consumed grant to private object storage without forwarding its token", async () => {
    mockResolve.mockResolvedValue({
      kind: "redirect",
      url: "https://bucket.example.com/reference.mp4?signed=1",
      attachment,
    });
    const request = new Request("http://localhost/api/internal/openmontage/artifact-grants/om_ag_1", {
      headers: { Authorization: "Bearer one-time-token" },
    });

    const response = await GET(request, { params: Promise.resolve({ grantId: "om_ag_1" }) });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://bucket.example.com/reference.mp4?signed=1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-sha256")).toBe("a".repeat(64));
    expect(response.headers.get("authorization")).toBeNull();
  });

  it("returns verified local bytes and hides invalid grant details", async () => {
    mockResolve.mockResolvedValue({ kind: "bytes", bytes: Buffer.from("video"), attachment });
    const bytes = await GET(new Request("http://localhost/grant", {
      headers: { Authorization: "Bearer one-time-token" },
    }), { params: Promise.resolve({ grantId: "om_ag_1" }) });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("video");
    expect(bytes.headers.get("content-type")).toBe("video/mp4");
    expect(bytes.headers.get("content-disposition")).toContain("reference.mp4");

    mockResolve.mockRejectedValue(new GrantError("already consumed"));
    const denied = await GET(new Request("http://localhost/grant", {
      headers: { Authorization: "Bearer reused-token" },
    }), { params: Promise.resolve({ grantId: "om_ag_1" }) });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      error: { code: "OPENMONTAGE_ARTIFACT_GRANT_INVALID" },
    });
  });

  it("streams an upload grant into a published employee artifact", async () => {
    mockPublish.mockResolvedValue({
      schemaVersion: 1,
      jobId: "om_job_1",
      employeeArtifactId: "eart-1",
      employeeId: "employee-1",
      role: "final_video",
      fileName: "final.mp4",
      mediaType: "video/mp4",
      sizeBytes: 5,
      sha256: "a".repeat(64),
      publishedAt: "2026-08-05T10:00:02Z",
    });
    const request = new Request("http://localhost/api/internal/openmontage/artifact-grants/om_ag_write_1", {
      method: "PUT",
      headers: { Authorization: "Bearer write-token", "Content-Type": "video/mp4" },
      body: Buffer.from("video"),
    });

    const response = await PUT(request, { params: Promise.resolve({ grantId: "om_ag_write_1" }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ employeeArtifactId: "eart-1" });
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({
      grantId: "om_ag_write_1",
      headers: request.headers,
      content: expect.anything(),
    }));
  });
});
