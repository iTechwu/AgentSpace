import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockDrain,
  mockIngest,
  mockReconcile,
  AuthenticationError,
  BindingError,
  ConflictError,
  NonceError,
  ValidationError,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockDrain: vi.fn(),
  mockIngest: vi.fn(),
  mockReconcile: vi.fn(),
  AuthenticationError: class extends Error {},
  BindingError: class extends Error {},
  ConflictError: class extends Error {},
  NonceError: class extends Error {},
  ValidationError: class extends Error {},
}));

vi.mock("@dofe-agent/services", () => ({
  dispatchOpenMontageProjectionNotificationSync: mockDispatch,
  drainOpenMontageJobDelegationAsync: mockDrain,
  ingestSignedOpenMontageEventSync: mockIngest,
  reconcileOpenMontageJobAsync: mockReconcile,
  OpenMontageEventAuthenticationError: AuthenticationError,
  OpenMontageEventValidationError: ValidationError,
}));

vi.mock("@dofe-agent/db", () => ({
  OpenMontageEventConflictError: ConflictError,
  OpenMontageEventNonceReplayError: NonceError,
  OpenMontageJobBindingError: BindingError,
}));

import { POST } from "./route";

describe("OpenMontage event ingress", () => {
  beforeEach(() => {
    process.env.OPENMONTAGE_EVENT_SIGNING_SECRET = "test-secret";
    mockDispatch.mockReset();
    mockDrain.mockReset();
    mockDrain.mockResolvedValue(undefined);
    mockIngest.mockReset();
    mockReconcile.mockReset();
    mockReconcile.mockResolvedValue({ lastAppliedSequence: 3 });
  });

  it("moves the models delegation to draining after a terminal Job event", async () => {
    mockIngest.mockReturnValue({
      outcome: "applied",
      projection: { jobId: "om_job_1", status: "SUCCEEDED", lastAppliedSequence: 8 },
    });

    const response = await POST(new Request("http://localhost/events", {
      method: "POST",
      body: "signed-body",
    }));

    expect(response.status).toBe(202);
    expect(mockDrain).toHaveBeenCalledWith("om_job_1");
  });

  afterEach(() => {
    delete process.env.OPENMONTAGE_EVENT_SIGNING_SECRET;
  });

  it("acknowledges persistence before dispatching a lightweight invalidation", async () => {
    const notification = { id: "notify-1" };
    mockIngest.mockReturnValue({
      outcome: "applied",
      projection: { lastAppliedSequence: 4 },
      notification,
    });

    const response = await POST(new Request("http://localhost/api/internal/openmontage/events", {
      method: "POST",
      body: "signed-body",
      headers: { "X-OpenMontage-Signature": "signature" },
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      outcome: "applied",
      lastAppliedSequence: 4,
    });
    expect(mockDispatch).toHaveBeenCalledWith(notification);
  });

  it("does not fail durable ingestion when realtime dispatch is unavailable", async () => {
    mockIngest.mockReturnValue({
      outcome: "gap",
      projection: { jobId: "om_job_1", lastAppliedSequence: 2 },
      notification: { id: "notify-2" },
    });
    mockDispatch.mockImplementation(() => {
      throw new Error("listener unavailable");
    });

    const response = await POST(new Request("http://localhost/events", {
      method: "POST",
      body: "signed-body",
    }));

    expect(response.status).toBe(202);
    expect(mockReconcile).toHaveBeenCalledWith("om_job_1");
    expect((await response.json()).lastAppliedSequence).toBe(3);
  });

  it("maps authentication failures without exposing verification details", async () => {
    mockIngest.mockImplementation(() => {
      throw new AuthenticationError("signature mismatch");
    });

    const response = await POST(new Request("http://localhost/events", {
      method: "POST",
      body: "body",
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "OPENMONTAGE_EVENT_UNAUTHORIZED" } });
  });

  it("fails closed when the signing secret is not configured", async () => {
    delete process.env.OPENMONTAGE_EVENT_SIGNING_SECRET;

    const response = await POST(new Request("http://localhost/events", {
      method: "POST",
      body: "body",
    }));

    expect(response.status).toBe(503);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});
