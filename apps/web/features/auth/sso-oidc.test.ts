import { afterEach, describe, expect, it, vi } from "vitest";

const mockReadServerEnvValue = vi.hoisted(() => vi.fn());

vi.mock("./server-env", () => ({
  readServerEnvValue: mockReadServerEnvValue,
}));

import { buildSsoProfile, getSsoLogoutUrl } from "./sso-oidc";
import { buildSsoWorkspaceScopes } from "./sso-workspaces";

afterEach(() => {
  vi.restoreAllMocks();
  mockReadServerEnvValue.mockReset();
});

describe("buildSsoProfile", () => {
  it("allows active SSO users without an email address", () => {
    const profile = buildSsoProfile({
      authoritativeUser: { nickname: "Phone user" },
      subject: "user-without-email",
      userInfo: { sub: "user-without-email" },
    });

    expect(profile).toMatchObject({
      displayName: "Phone user",
      emailVerified: false,
      subject: "user-without-email",
    });
    expect(profile.email).toMatch(/^sso-[a-z0-9_-]+@users\.dofe\.invalid$/);
  });

  it("continues to reject an unverified SSO email", () => {
    expect(() => buildSsoProfile({
      authoritativeUser: { email: "user@example.com" },
      subject: "user-with-email",
      userInfo: { email_verified: false },
    })).toThrow("auth.sso_email_not_verified");
  });
});

describe("getSsoLogoutUrl", () => {
  it("uses the registered callback URI for post-logout navigation", async () => {
    const values: Record<string, string> = {
      SSO_API_URL: "https://sso.example.test/api",
      SSO_CLIENT_ID: "dofe-agent-web",
      SSO_CLIENT_SECRET: "secret",
      SSO_DISCOVERY_URL: "https://sso.example.test/api/.well-known/openid-configuration",
      SSO_INTERNAL_API_URL: "https://sso.example.test/api",
      INTERNAL_API_SECRET: "internal-secret",
      SSO_ISSUER: "https://sso.example.test/api",
      JWKS_URI: "https://sso.example.test/api/.well-known/jwks.json",
      SSO_REDIRECT_URI: "https://dofe-agent.example.com/auth/callback",
      SSO_SERVICE_NAME: "dofe-agent.example.com",
    };
    mockReadServerEnvValue.mockImplementation((name: string) => values[name]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authorization_endpoint: "https://sso.example.test/api/oauth/authorize",
      end_session_endpoint: "https://sso.example.test/api/oauth/logout",
      issuer: values.SSO_ISSUER,
      jwks_uri: values.JWKS_URI,
      token_endpoint: "https://sso.example.test/api/oauth/token",
      userinfo_endpoint: "https://sso.example.test/api/oauth/userinfo",
    }))));

    const url = new URL(await getSsoLogoutUrl("id-token"));

    expect(url.origin + url.pathname).toBe("https://sso.example.test/api/oauth/logout");
    expect(url.searchParams.get("client_id")).toBe(values.SSO_CLIENT_ID);
    expect(url.searchParams.get("id_token_hint")).toBe("id-token");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(values.SSO_REDIRECT_URI);
  });
});

describe("buildSsoWorkspaceScopes", () => {
  it("uses SSO team names as workspaces and prefers the selected tenant", () => {
    const scopes = buildSsoWorkspaceScopes({
      preferredTenantId: "tenant-b",
      teams: [
        { teamId: "team-a", teamSlug: "design", teamName: "Design", tenantId: "tenant-a", tenantSlug: "north", tenantName: "Northstar", role: "MEMBER" },
        { teamId: "team-b", teamSlug: "engineering", teamName: "Engineering", tenantId: "tenant-b", tenantSlug: "orbit", tenantName: "Orbit", role: "ADMIN" },
      ],
      tenants: [
        { tenantId: "tenant-a", tenantSlug: "north", tenantName: "Northstar", tenantDisplayName: null, role: "MEMBER" },
        { tenantId: "tenant-b", tenantSlug: "orbit", tenantName: "Orbit", tenantDisplayName: null, role: "ADMIN" },
      ],
    });

    expect(scopes.map((scope) => scope.name)).toEqual(["Orbit / Engineering", "Northstar / Design"]);
    expect(scopes[0]?.role).toBe("admin");
  });
});
