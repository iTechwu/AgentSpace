import { describe, expect, it } from "vitest";
import { assertWorkspaceRole, hasWorkspaceRole } from "./workspace-permissions";

describe("workspace permissions", () => {
  it("allows owner and admin for admin-level operations", () => {
    expect(hasWorkspaceRole("owner", "admin")).toBe(true);
    expect(hasWorkspaceRole("admin", "admin")).toBe(true);
    expect(hasWorkspaceRole("member", "admin")).toBe(false);
  });

  it("throws when the current role is below the required role", () => {
    expect(() => assertWorkspaceRole("member", "owner")).toThrow("Forbidden.");
  });
});
