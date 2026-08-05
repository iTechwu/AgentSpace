import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIssue, AuthenticationError, ConfigurationError, ValidationError } = vi.hoisted(() => ({
  mockIssue: vi.fn(),
  AuthenticationError: class extends Error {},
  ConfigurationError: class extends Error {},
  ValidationError: class extends Error {},
}));

vi.mock("@dofe-agent/services", () => ({
  issueOpenMontageArtifactReadGrant: mockIssue,
  OpenMontageArtifactAuthenticationError: AuthenticationError,
  OpenMontageArtifactConfigurationError: ConfigurationError,
  OpenMontageArtifactValidationError: ValidationError,
}));

import { POST } from "./route";

describe("OpenMontage artifact grant issue route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DOFE_AGENT_INTERNAL_URL;
    mockIssue.mockReturnValue({
      schemaVersion: 1,
      grantId: "om_ag_1",
      operation: "READ",
      downloadUrl: "http://agentspace.internal/api/internal/openmontage/artifact-grants/om_ag_1",
      token: "one-time-token",
      expiresAt: "2026-08-05T10:05:00Z",
      artifact: {
        artifactId: "att-video-1",
        fileName: "reference.mp4",
        mediaType: "video/mp4",
        sizeBytes: 5,
        sha256: "a".repeat(64),
      },
    });
  });

  it("issues a Job-bound read grant using the configured internal origin", async () => {
    process.env.DOFE_AGENT_INTERNAL_URL = "http://agentspace.internal";
    const request = new Request("http://public.example/api/internal/openmontage/jobs/om_job_1/artifact-grants", {
      method: "POST",
      headers: {
        Authorization: "Bearer service-token",
        "Content-Type": "application/json",
        "X-Dofe-Job-Attribution": "encoded-attribution",
      },
      body: JSON.stringify({ attachmentId: "att-video-1" }),
    });

    const response = await POST(request, { params: Promise.resolve({ jobId: "om_job_1" }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ grantId: "om_ag_1", token: "one-time-token" });
    expect(mockIssue).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "om_job_1",
      attachmentId: "att-video-1",
      headers: request.headers,
      baseUrl: "http://agentspace.internal",
    }));
  });

  it("maps malformed input and authentication failures without exposing details", async () => {
    const malformed = await POST(new Request("http://localhost/grants", {
      method: "POST",
      body: JSON.stringify({ attachmentId: "" }),
    }), { params: Promise.resolve({ jobId: "om_job_1" }) });
    expect(malformed.status).toBe(422);
    expect(mockIssue).not.toHaveBeenCalled();

    mockIssue.mockImplementation(() => { throw new AuthenticationError("binding mismatch"); });
    const unauthorized = await POST(new Request("http://localhost/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: "att-video-1" }),
    }), { params: Promise.resolve({ jobId: "om_job_1" }) });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: { code: "OPENMONTAGE_ARTIFACT_UNAUTHORIZED" },
    });
  });
});
