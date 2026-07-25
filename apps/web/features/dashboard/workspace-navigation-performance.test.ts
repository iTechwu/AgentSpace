import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markWorkspaceModuleNavigationClick,
  measureWorkspaceModuleNavigationCacheHit,
  measureWorkspaceModuleNavigationFirstLoad,
  recordWorkspaceInitialModuleClientRender,
  recordWorkspaceInitialModulePayload,
  recordWorkspaceModuleRouterRefreshFallback,
  recordWorkspaceShellCountersRefresh,
} from "@/features/dashboard/workspace-navigation-performance";
import type { WorkspaceModuleRouteState } from "@/features/dashboard/workspace-module-route";

describe("workspace navigation performance helpers", () => {
  const originalPerformance = window.performance;
  const originalConsoleDebug = console.debug;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: originalPerformance,
    });
    console.debug = originalConsoleDebug;
  });

  it("records shell counter refresh count and interval in development", () => {
    const mark = vi.fn();
    const measure = vi.fn();
    const clearMarks = vi.fn();
    const clearMeasures = vi.fn();
    const getEntriesByName = vi.fn(() => [{ duration: 125 }]);
    const debug = vi.fn();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: {
        clearMarks,
        clearMeasures,
        getEntriesByName,
        mark,
        measure,
      },
    });
    console.debug = debug;

    recordWorkspaceShellCountersRefresh("workspace-alpha");
    recordWorkspaceShellCountersRefresh("workspace-alpha");

    expect(mark).toHaveBeenCalledWith("dofe-agent.workspace.shell-counters.workspace-alpha.refresh.1");
    expect(mark).toHaveBeenCalledWith("dofe-agent.workspace.shell-counters.workspace-alpha.refresh.2");
    expect(measure).toHaveBeenCalledWith(
      "dofe-agent.workspace.shell-counters.workspace-alpha.refresh-interval",
      "dofe-agent.workspace.shell-counters.workspace-alpha.refresh.1",
      "dofe-agent.workspace.shell-counters.workspace-alpha.refresh.2",
    );
    expect(clearMarks).toHaveBeenCalledWith("dofe-agent.workspace.shell-counters.workspace-alpha.refresh.1");
    expect(clearMeasures).toHaveBeenCalledWith("dofe-agent.workspace.shell-counters.workspace-alpha.refresh-interval");
    expect(debug).toHaveBeenCalledWith("[workspace:shell-counters] workspace-alpha refresh #1");
    expect(debug).toHaveBeenCalledWith("[workspace:shell-counters] workspace-alpha refresh #2 interval 125ms");
  });

  it("records cached and first-load module navigation timings in development", () => {
    const mark = vi.fn();
    const measure = vi.fn();
    const clearMarks = vi.fn();
    const clearMeasures = vi.fn();
    const getEntriesByName = vi.fn(() => [{ duration: 42 }]);
    const debug = vi.fn();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: {
        clearMarks,
        clearMeasures,
        getEntriesByName,
        mark,
        measure,
      },
    });
    console.debug = debug;
    const routeState = buildRouteState("im");

    markWorkspaceModuleNavigationClick(routeState);
    measureWorkspaceModuleNavigationCacheHit(routeState);
    measureWorkspaceModuleNavigationFirstLoad(routeState);

    expect(mark).toHaveBeenCalledWith("dofe-agent.workspace.navigation.im.click");
    expect(measure).toHaveBeenCalledWith(
      "dofe-agent.workspace.navigation.im.click-to-cached-content",
      "dofe-agent.workspace.navigation.im.click",
      "dofe-agent.workspace.navigation.im.click-to-cached-content.end",
    );
    expect(measure).toHaveBeenCalledWith(
      "dofe-agent.workspace.navigation.im.click-to-first-load",
      "dofe-agent.workspace.navigation.im.click",
      "dofe-agent.workspace.navigation.im.click-to-first-load.end",
    );
    expect(debug).toHaveBeenCalledWith("[workspace:nav] im click-to-cached-content 42ms");
    expect(debug).toHaveBeenCalledWith("[workspace:nav] im click-to-first-load 42ms");
  });

  it("records initial module seed size with available route payload timings in development", () => {
    const moduleData = {
      moduleId: "im",
      data: {
        title: "Alpha",
      },
    };
    const seedBytes = new TextEncoder().encode(JSON.stringify(moduleData)).length;
    const debug = vi.fn();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: {
        getEntriesByType: vi.fn((type: string) => {
          if (type === "resource") {
            return [
              {
                decodedBodySize: 2400,
                duration: 75,
                encodedBodySize: 1200,
                name: "http://localhost/w/workspace-alpha/im?_rsc=abc",
                transferSize: 1500,
              },
            ];
          }
          if (type === "navigation") {
            return [
              {
                decodedBodySize: 16000,
                duration: 130,
                encodedBodySize: 8000,
                name: "http://localhost/w/workspace-alpha/im",
                transferSize: 9000,
              },
            ];
          }
          return [];
        }),
      },
    });
    console.debug = debug;

    recordWorkspaceInitialModulePayload({
      moduleData,
      moduleId: "im",
      queryKey: "focus=channel%3Aalpha",
      serverDurationMs: 33,
      workspaceId: "workspace-1",
    });

    expect(debug).toHaveBeenCalledWith(
      `[workspace:initial] im; workspace workspace-1; query focus=channel%3Aalpha; seed ${seedBytes} bytes; server 33ms; rsc transfer 1500 bytes encoded 1200 bytes decoded 2400 bytes duration 75ms; route transfer 9000 bytes encoded 8000 bytes decoded 16000 bytes duration 130ms`,
    );
  });

  it("records initial module client render timing after paint", () => {
    const debug = vi.fn();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: {
        getEntriesByType: vi.fn((type: string) => type === "navigation"
          ? [
              {
                name: "http://localhost/w/workspace-alpha/im",
                startTime: 1000,
              },
            ]
          : []),
        now: vi.fn(() => 1250),
      },
    });
    console.debug = debug;

    recordWorkspaceInitialModuleClientRender({
      moduleId: "im",
      queryKey: "",
      workspaceId: "workspace-1",
    });

    expect(debug).toHaveBeenCalledWith(
      "[workspace:initial-render] im; workspace workspace-1; query default; client render 250ms",
    );
  });

  it("records router refresh fallbacks in development", () => {
    const debug = vi.fn();
    Object.defineProperty(window, "performance", {
      configurable: true,
      value: {},
    });
    console.debug = debug;

    recordWorkspaceModuleRouterRefreshFallback("missing module data callback");

    expect(debug).toHaveBeenCalledWith(
      "[workspace:refresh] router.refresh fallback; reason missing module data callback",
    );
  });
});

function buildRouteState(moduleId: WorkspaceModuleRouteState["moduleId"]): WorkspaceModuleRouteState {
  return {
    agentsMode: "agent",
    appPath: moduleId ? `/${moduleId}` : "/",
    conversationView: "all",
    isConversationLayout: false,
    isDigitalContactsView: false,
    isHumanContactsView: false,
    isSettingsPath: false,
    knowledgeView: "knowledge",
    moduleId,
    searchParams: new URLSearchParams(),
    settingsPath: [],
  };
}
