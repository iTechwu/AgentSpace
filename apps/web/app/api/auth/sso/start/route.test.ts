import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateSsoAuthorizationRequest = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/sso-oidc", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/auth/sso-oidc")>(),
  createSsoAuthorizationRequest: mockCreateSsoAuthorizationRequest,
}));

vi.mock("@/features/auth/server-env", () => ({
  readServerEnvValue: (name: string) =>
    name === "SSO_REDIRECT_URI" ? "https://dofe-agent.local.dofe.ai/auth/callback" : undefined,
}));

import { GET } from "./route";

describe("SSO start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the configured public origin when SSO startup fails behind a reverse proxy", async () => {
    mockCreateSsoAuthorizationRequest.mockRejectedValue(new Error("auth.sso_discovery_failed"));

    const response = await GET(new Request("https://0.0.0.0:1455/api/auth/sso/start"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://dofe-agent.local.dofe.ai/auth/error?code=auth.sso_discovery_failed",
    );
  });
});
