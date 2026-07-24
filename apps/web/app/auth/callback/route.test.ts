import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCookies,
  mockDecodeSsoOidcState,
  mockExchangeSsoAuthorizationCode,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockDecodeSsoOidcState: vi.fn(),
  mockExchangeSsoAuthorizationCode: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mockCookies,
}));

vi.mock("@/features/auth/sso-oidc", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/auth/sso-oidc")>(),
  decodeSsoOidcState: mockDecodeSsoOidcState,
  exchangeSsoAuthorizationCode: mockExchangeSsoAuthorizationCode,
}));

vi.mock("@/features/auth/server-env", () => ({
  readServerEnvValue: (name: string) => name === "SSO_REDIRECT_URI" ? "https://agentspace.local.dofe.ai/auth/callback" : undefined,
}));

import { GET } from "./route";

describe("SSO callback route", () => {
  beforeEach(() => {
    mockCookies.mockResolvedValue({
      get: () => ({ value: "encoded-state" }),
    });
    mockDecodeSsoOidcState.mockReturnValue({
      codeVerifier: "v".repeat(48),
      nonce: "n".repeat(24),
      state: "s".repeat(24),
    });
    mockExchangeSsoAuthorizationCode.mockRejectedValue(new Error("auth.sso_profile_missing_email"));
  });

  it("uses the configured public origin for callback failures behind a reverse proxy", async () => {
    const response = await GET(new Request("https://0.0.0.0:1455/auth/callback?code=code-1&state=state-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://agentspace.local.dofe.ai/auth/error?code=auth.sso_profile_missing_email",
    );
  });
});
