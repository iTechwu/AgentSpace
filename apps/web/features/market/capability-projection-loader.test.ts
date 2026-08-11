import { afterEach, describe, expect, it } from "vitest";
import { overlayCapabilityRequestState } from "./capability-projection-loader";
import type { CapabilityAvailabilityProjection } from "@dofe-agent/services";

const baseProjection: CapabilityAvailabilityProjection = {
  packageId: "clihub_harness:mermaid",
  runtimeId: "runtime-1",
  kind: "cli",
  deploymentMode: "runtime_package",
  catalogState: "approved",
  infrastructureState: "ready",
  userState: "blocked",
  nextAction: "install",
  reasonText: "可安装。",
  canManage: true,
};

describe("overlayCapabilityRequestState", () => {
  it("returns the projection unchanged when no request is linked", () => {
    expect(overlayCapabilityRequestState(baseProjection, undefined)).toBe(baseProjection);
  });

  it("maps a pending request to wait_for_approval and attaches the id", () => {
    const result = overlayCapabilityRequestState(baseProjection, {
      id: "req-1",
      runtimeId: "runtime-1",
      packageKind: "cli",
      packageSource: "clihub_harness",
      packageSlug: "mermaid",
      status: "pending",
    });
    expect(result.nextAction).toBe("wait_for_approval");
    expect(result.capabilityRequestId).toBe("req-1");
  });

  it("maps an approved request to wait_for_approval (still awaiting dispatch)", () => {
    const result = overlayCapabilityRequestState(baseProjection, {
      id: "req-2",
      packageKind: "cli",
      packageSource: "clihub_harness",
      packageSlug: "mermaid",
      status: "approved",
    });
    expect(result.nextAction).toBe("wait_for_approval");
    expect(result.capabilityRequestId).toBe("req-2");
  });

  it("maps an approved MCP request to configure_credentials (applicant must finish the connection)", () => {
    // Credential/endpoint-bearing MCPs cannot be auto-dispatched, so they
    // linger in `approved` until the applicant completes "配置并连接". The
    // market panel routes configure_credentials to the same connect form.
    const result = overlayCapabilityRequestState(baseProjection, {
      id: "req-mcp",
      packageKind: "mcp",
      packageSource: "official",
      packageSlug: "official-openmontage",
      status: "approved",
    });
    expect(result.nextAction).toBe("configure_credentials");
    expect(result.capabilityRequestId).toBe("req-mcp");
  });

  it("maps a running request to wait_for_operation", () => {
    const result = overlayCapabilityRequestState(baseProjection, {
      id: "req-3",
      packageKind: "cli",
      packageSource: "clihub_harness",
      packageSlug: "mermaid",
      status: "running",
    });
    expect(result.nextAction).toBe("wait_for_operation");
    expect(result.capabilityRequestId).toBe("req-3");
  });

  it("does not overlay a terminal request — package keeps its actual state", () => {
    for (const status of ["completed", "failed", "rejected", "cancelled"]) {
      const result = overlayCapabilityRequestState(baseProjection, {
        id: "req-terminal",
        packageKind: "cli",
        packageSource: "clihub_harness",
        packageSlug: "mermaid",
        status,
      });
      expect(result.nextAction).toBe("install");
      expect(result.capabilityRequestId).toBeUndefined();
    }
  });
});

import { projectCliCapabilityAvailability, projectMcpCapabilityAvailability } from "@dofe-agent/services";

function cliItem(): Parameters<typeof projectCliCapabilityAvailability>[0]["item"] {
  return {
    source: "clihub_public",
    name: "mermaid-cli",
    displayName: "Mermaid",
    description: "Render diagrams",
    version: "1.0.0",
    category: "diagram",
    entryPoint: "mmdc",
    installStrategy: "npm",
    installCmd: "npm install -g mermaid-cli",
    registryJson: JSON.stringify({ npm_package_spec: "mermaid-cli@1.0.0" }),
    syncedAt: "2026-08-11T00:00:00.000Z",
  };
}

function cliWorkspace(profile?: Parameters<typeof projectCliCapabilityAvailability>[0]["workspace"]["profile"]): Parameters<typeof projectCliCapabilityAvailability>[0]["workspace"] {
  return {
    workspaceId: "default",
    runtimeId: "runtime-1",
    runtimeStatus: "online",
    canManage: true,
    readiness: { npm: true, python: true, pip: true, cliHub: true },
    profile,
  };
}

describe("execution profile negotiation", () => {
  it("degrades CLI to request_deployment when the runtime cannot persist installs", () => {
    const projection = projectCliCapabilityAvailability({
      workspace: cliWorkspace({ writableHome: false, runtimePackageExecutor: true }),
      item: cliItem(),
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("request_deployment");
    expect(projection.reasonCode).toBe("runtime.profile_home_not_writable");
  });

  it("keeps CLI installable when the profile is unknown (older daemon)", () => {
    const projection = projectCliCapabilityAvailability({
      workspace: cliWorkspace(undefined),
      item: cliItem(),
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("install");
  });

  it("degrades MCP to request_deployment when the runtime has no MCP gateway", () => {
    const projection = projectMcpCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online",
        canManage: true,
        readiness: { npm: true, python: true, pip: true, cliHub: true },
        profile: { mcpGateway: false },
      },
      catalogItem: {
        id: "mcp-1",
        transport: "streamable_http",
        slug: "test-mcp",
        displayName: "Test MCP",
        risk: "low",
        declaredToolsJson: "[]",
        requiredRuntimeCapabilitiesJson: "[]",
      },
      connectionStatus: null,
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("request_deployment");
    expect(projection.reasonCode).toBe("runtime.profile_mcp_gateway_unavailable");
  });

  it("keeps MCP connectable when the profile does not assert the gateway", () => {
    const projection = projectMcpCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online",
        canManage: true,
        readiness: { npm: true, python: true, pip: true, cliHub: true },
        profile: undefined,
      },
      catalogItem: {
        id: "mcp-1",
        transport: "streamable_http",
        slug: "test-mcp",
        displayName: "Test MCP",
        risk: "low",
        declaredToolsJson: "[]",
        requiredRuntimeCapabilitiesJson: "[]",
      },
      connectionStatus: null,
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("configure_credentials");
  });
});

describe("runtime baseline rollout gating", () => {
  const originalBaselineFlag = process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED;

  afterEach(() => {
    if (originalBaselineFlag === undefined) delete process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED;
    else process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = originalBaselineFlag;
  });

  it("offers install for a missing-tool CLI when baseline rollout is enabled", () => {
    process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = "1";
    const projection = projectCliCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online",
        canManage: false, // member — normally blocked on request_deployment
        readiness: { npm: false, python: true, pip: true, cliHub: true },
      },
      item: cliItem(), // requires npm
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("install");
    expect(projection.reasonText).toContain("自动补装");
  });

  it("keeps request_deployment for a member when baseline rollout is disabled", () => {
    process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = "0";
    const projection = projectCliCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online",
        canManage: false,
        readiness: { npm: false, python: true, pip: true, cliHub: true },
      },
      item: cliItem(),
      activeOperations: [],
    });
    expect(projection.nextAction).toBe("request_deployment");
  });
});

describe("CLI/MCP multi-implementation negotiation", () => {
  it("blocks MCP actions while the target Runtime is offline", () => {
    const projection = projectMcpCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "offline",
        canManage: true,
        readiness: { npm: true, python: true, pip: true, cliHub: true },
      },
      catalogItem: {
        id: "mcp-offline",
        transport: "streamable_http",
        slug: "offline-mcp",
        displayName: "Offline MCP",
        risk: "low",
        declaredToolsJson: "[]",
        requiredRuntimeCapabilitiesJson: "[]",
      },
      connectionStatus: null,
      activeOperations: [],
    });
    expect(projection.userState).toBe("blocked");
    expect(projection.nextAction).toBe("request_deployment");
    expect(projection.reasonCode).toBe("runtime.offline");
  });

  it("offers the dependency CLI as an alternative for a managed_stdio MCP", () => {
    const projection = projectMcpCapabilityAvailability({
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online",
        canManage: true,
        readiness: { npm: true, python: true, pip: true, cliHub: true },
        profile: undefined,
      },
      catalogItem: {
        id: "mcp-1",
        transport: "managed_stdio",
        slug: "chrome-devtools-mcp",
        displayName: "Chrome DevTools",
        risk: "medium",
        declaredToolsJson: "[]",
        requiredRuntimeCapabilitiesJson: "[]",
        requiredRuntimeApp: { source: "clihub_public", name: "chrome-devtools-mcp", version: "1.0.0" },
      },
      connectionStatus: null,
      activeOperations: [],
    });
    expect(projection.selectedImplementation).toBe("runtime_package");
    expect(projection.alternativeImplementations).toBeUndefined();
    expect(projection.selectionReason).toContain("依赖 CLI");
    expect(typeof projection.runtimeProfileRevision).toBe("string");
  });

  it("reports a stable runtimeProfileRevision for an unchanged profile", () => {
    const base = {
      workspace: {
        workspaceId: "default",
        runtimeId: "runtime-1",
        runtimeStatus: "online" as const,
        canManage: true,
        readiness: { npm: true, python: true, pip: true, cliHub: true },
        profile: { mcpGateway: true } as const,
      },
      item: cliItem(),
      activeOperations: [] as never[],
    };
    const a = projectCliCapabilityAvailability(base);
    const b = projectCliCapabilityAvailability({ ...base, workspace: { ...base.workspace } });
    expect(a.runtimeProfileRevision).toBe(b.runtimeProfileRevision);
  });
});
