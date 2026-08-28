import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { recordWorkspaceModuleRouterRefreshFallback } from "@/features/dashboard/workspace-navigation-performance";

vi.mock("@/features/dashboard/workspace-navigation-performance", () => ({
  recordWorkspaceModuleRouterRefreshFallback: vi.fn(),
}));

describe("refreshWorkspaceModule", () => {
  beforeEach(() => {
    vi.mocked(recordWorkspaceModuleRouterRefreshFallback).mockClear();
  });

  it("uses module data callbacks without refreshing the route", () => {
    const onDataChanged = vi.fn();
    const router = { refresh: vi.fn() };

    refreshWorkspaceModule(onDataChanged, router);

    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(recordWorkspaceModuleRouterRefreshFallback).not.toHaveBeenCalled();
  });

  it("records and uses the router refresh fallback when no module callback exists", () => {
    const router = { refresh: vi.fn() };

    refreshWorkspaceModule(undefined, router);

    expect(recordWorkspaceModuleRouterRefreshFallback).toHaveBeenCalledWith("missing module data callback");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
