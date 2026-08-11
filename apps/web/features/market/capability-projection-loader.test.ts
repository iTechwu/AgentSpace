import { describe, expect, it } from "vitest";
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
