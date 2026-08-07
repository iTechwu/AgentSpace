import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIssueCredential } = vi.hoisted(() => ({ mockIssueCredential: vi.fn() }));

vi.mock("@dofe-agent/services", () => ({
  issueOpenMontageModelCredential: mockIssueCredential,
  OpenMontageDelegationAuthenticationError: class OpenMontageDelegationAuthenticationError extends Error {},
  OpenMontageDelegationConfigurationError: class OpenMontageDelegationConfigurationError extends Error {},
}));

import { POST } from "./route";

describe("OpenMontage model credential route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueCredential.mockReturnValue({
      schemaVersion: 1,
      jobId: "om_job_1",
      stage: "research",
      delegationId: "delegation-1",
      apiKey: "delegated-api-key",
    });
  });

  it("returns a non-cacheable stage-scoped credential", async () => {
    const request = new Request("http://agents.test/api/internal/openmontage/jobs/om_job_1/model-credential", {
      method: "POST",
      headers: { authorization: "Bearer service-token", "content-type": "application/json" },
      body: JSON.stringify({ stage: "research" }),
    });
    const response = await POST(request, { params: Promise.resolve({ jobId: "om_job_1" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ apiKey: "delegated-api-key", stage: "research" });
    expect(mockIssueCredential).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "om_job_1",
      stage: "research",
    }));
  });

  it("rejects an undeclared stage before reading the vault", async () => {
    const response = await POST(new Request("http://agents.test/api/internal/openmontage/jobs/om_job_1/model-credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "" }),
    }), { params: Promise.resolve({ jobId: "om_job_1" }) });

    expect(response.status).toBe(422);
    expect(mockIssueCredential).not.toHaveBeenCalled();
  });
});
