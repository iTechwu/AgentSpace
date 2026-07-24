import { describe, expect, it } from "vitest";
import { buildSsoProfile } from "./sso-oidc";
import { buildSsoWorkspaceScopes } from "./sso-workspaces";

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
