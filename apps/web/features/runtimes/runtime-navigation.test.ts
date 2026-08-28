import { describe, expect, it } from "vitest";
import {
  getRuntimeManagementPath,
  isLegacyRuntimeManagementRequest,
} from "@/features/runtimes/runtime-navigation";

describe("runtime management navigation", () => {
  it("uses managed creation in remote mode and server connection in local mode", () => {
    expect(getRuntimeManagementPath("remote")).toBe("/runtimes");
    expect(getRuntimeManagementPath("local")).toBe("/agents?mode=container");
  });

  it("redirects only the legacy container view in remote mode", () => {
    expect(isLegacyRuntimeManagementRequest("remote", "container")).toBe(true);
    expect(isLegacyRuntimeManagementRequest("remote", "agent")).toBe(false);
    expect(isLegacyRuntimeManagementRequest("local", "container")).toBe(false);
  });
});
