import { describe, expect, it } from "vitest";
import { normalizeWorkspaceSlugParam } from "./workspace-slug";

describe("normalizeWorkspaceSlugParam", () => {
  it("decodes a percent-encoded dynamic route segment", () => {
    expect(
      normalizeWorkspaceSlugParam(
        "yootun-all-%E4%BC%98%E6%83%A0%E8%B1%9A-%E5%85%A8%E4%BD%93-87e967",
      ),
    ).toBe("yootun-all-优惠豚-全体-87e967");
  });

  it("leaves malformed encoding for normal missing-workspace handling", () => {
    expect(normalizeWorkspaceSlugParam("broken-%E0%A4")).toBe("broken-%E0%A4");
  });
});
