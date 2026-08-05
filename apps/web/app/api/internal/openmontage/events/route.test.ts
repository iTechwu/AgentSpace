import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockIngest,
  AuthenticationError,
  BindingError,
  ConflictError,
  NonceError,
  ValidationError,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockIngest: vi.fn(),
  AuthenticationError: class extends Error {},
  BindingError: class extends Error {},
  ConflictError: class extends Error {},
  NonceError: class extends Error {},
  ValidationError: class extends Error {},
}));

vi.mock("@dofe-agent/services", () => ({
  dispatchOpenMontageProjectionNotificationSync: mockDispatch,
  ingestSignedOpenMontageEventSync: mockIngest,
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
    mockIngest.mockReset();
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
      projection: { lastAppliedSequence: 2 },
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
