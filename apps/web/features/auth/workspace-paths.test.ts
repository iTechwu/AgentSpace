import { describe, expect, it } from "vitest";
import { buildWorkspacePath, parseWorkspacePathname } from "./workspace-paths";

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
});
