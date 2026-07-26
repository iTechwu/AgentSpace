import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCookies,
  mockCreateSessionForSsoLogin,
  mockDecodeSsoOidcState,
  mockExchangeSsoAuthorizationCode,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateSessionForSsoLogin: vi.fn(),
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
  readServerEnvValue: (name: string) => name === "SSO_REDIRECT_URI" ? "https://dofe-agent.local.dofe.ai/auth/callback" : undefined,
}));

vi.mock("@/features/auth/server-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/auth/server-auth")>(),
  createSessionForSsoLogin: mockCreateSessionForSsoLogin,
}));

import { GET } from "./route";

describe("SSO callback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookies.mockResolvedValue({
      get: () => ({ value: "encoded-state" }),
    });
    mockDecodeSsoOidcState.mockReturnValue({
      codeVerifier: "v".repeat(48),
      nonce: "n".repeat(24),
      state: "s".repeat(24),
    });
    mockExchangeSsoAuthorizationCode.mockRejectedValue(new Error("auth.sso_profile_missing_email"));
    mockCreateSessionForSsoLogin.mockResolvedValue({
      isNewUser: false,
      session: { idToken: "id-token", sessionToken: "session-token" },
      user: { displayName: "User", email: "user@example.com", id: "user-1", organizationName: "Org", role: "member" },
    });
  });

  it("uses the configured public origin for callback failures behind a reverse proxy", async () => {
    const response = await GET(new Request("https://0.0.0.0:1455/auth/callback?code=code-1&state=state-1"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://dofe-agent.local.dofe.ai/auth/error?code=auth.sso_profile_missing_email",
    );
  });

  it("returns to the application after an SSO logout callback without authorization parameters", async () => {
    const response = await GET(new Request("https://0.0.0.0:1455/auth/callback"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://dofe-agent.local.dofe.ai/");
    expect(mockExchangeSsoAuthorizationCode).not.toHaveBeenCalled();
  });

  it("writes the authenticated session cookies to the callback redirect response", async () => {
    mockExchangeSsoAuthorizationCode.mockResolvedValue({
      idToken: "id-token",
      profile: {
        displayName: "User",
        email: "user@example.com",
        emailVerified: true,
        subject: "sso-user-1",
        workspaceScopes: [{ id: "workspace-1", name: "Workspace", role: "member", tenantId: "tenant-1", tenantName: "Tenant" }],
      },
    });

    const response = await GET(new Request("https://0.0.0.0:1455/auth/callback?code=code-1&state=state-1"));

    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("dofe_agent_session=session-token");
    expect(setCookie).toContain("dofe_agent_sso_id_token=id-token");
    expect(mockCreateSessionForSsoLogin).toHaveBeenCalledOnce();
  });
});
