import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseWorkspaceClientModule,
  getWorkspaceModuleClientFlagName,
} from "@/features/dashboard/workspace-workbench-flags";

describe("workspace workbench flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows modules by default while global workbench flags are enabled", () => {
    expect(canUseWorkspaceClientModule("im")).toBe(true);
    expect(canUseWorkspaceClientModule("agents")).toBe(true);
    expect(getWorkspaceModuleClientFlagName("im")).toBe("NEXT_PUBLIC_WORKSPACE_MODULE_IM_CLIENT_ENABLED");
  });

  it("lets a module opt out of client workbench navigation", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_MODULE_IM_CLIENT_ENABLED", "0");

    expect(canUseWorkspaceClientModule("im")).toBe(false);
    expect(canUseWorkspaceClientModule("agents")).toBe(true);
  });

  it("requires the global workbench and cache flags", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_CLIENT_WORKBENCH_ENABLED", "0");

    expect(canUseWorkspaceClientModule("im")).toBe(false);

    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_MODULE_CACHE_ENABLED", "0");

    expect(canUseWorkspaceClientModule("im")).toBe(false);
  });
});
