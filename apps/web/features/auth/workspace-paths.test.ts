import { describe, expect, it } from "vitest";
import { buildWorkspacePath, canonicalWorkspacePath, parseWorkspacePathname } from "./workspace-paths";

describe("workspace paths", () => {
  it("round-trips an encoded workspace slug in a deep link", () => {
    const slug = "k22-all-k22-全体-5af9bc";
    const path = buildWorkspacePath(slug, "/im?view=direct");

    expect(path).toBe("/w/k22-all-k22-%E5%85%A8%E4%BD%93-5af9bc/im?view=direct");
    expect(parseWorkspacePathname(path.split("?", 1)[0]!)).toEqual({
      workspaceSlug: slug,
      appPath: "/im",
    });
  });

  it("replaces a legacy workspace identifier while preserving the route state", () => {
    expect(canonicalWorkspacePath({
      requestedWorkspaceIdentifier: "全体-优惠豚-87e967",
      workspaceId: "sso-team-1234567890",
      pathname: "/agents",
      search: "?mode=agent&focus=agent%3Aemployee-1",
      hash: "#details",
    })).toBe("/w/sso-team-1234567890/agents?mode=agent&focus=agent%3Aemployee-1#details");
  });

  it("does not rewrite an already canonical workspace identifier", () => {
    expect(canonicalWorkspacePath({
      requestedWorkspaceIdentifier: "workspace-1",
      workspaceId: "workspace-1",
      pathname: "/im",
    })).toBeNull();
  });

  it("returns null for an empty or malformed workspace identifier", () => {
    expect(canonicalWorkspacePath({
      requestedWorkspaceIdentifier: " ",
      workspaceId: "workspace-1",
      pathname: "/im",
    })).toBeNull();
    expect(() => parseWorkspacePathname("/w/%E0%A4%A/im")).not.toThrow();
  });
});
