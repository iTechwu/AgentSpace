import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  listWorkspacesSync: vi.fn(),
}));
const services = vi.hoisted(() => ({
  evaluateDataProtectionHealthSync: vi.fn(),
  sendExternalPagerAlert: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => db);
vi.mock("@dofe-agent/services", () => services);

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

function healthyHealth(workspaceId: string) {
  return {
    alerts: [],
    metrics: {
      workspaceHeadAgeSeconds: 0,
      skillArtifactVerificationFailures: 0,
      runtimeBindingGenerationConflicts: 0,
      taskCommitReconciliationBacklog: 0,
      runtimeRecoveryDurationSeconds: 0,
    },
    checkedAt: "2026-08-02T00:00:00.000Z",
    workspaceId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listWorkspacesSync.mockReturnValue([
    { id: "default", slug: "default", name: "Dofe Agent", createdBy: "", createdAt: "", updatedAt: "" },
    { id: "ws-2", slug: "ws-2", name: "Tenant 2", createdBy: "", createdAt: "", updatedAt: "" },
  ]);
  services.evaluateDataProtectionHealthSync.mockImplementation((options: { workspaceId?: string }) =>
    healthyHealth(options?.workspaceId ?? "default"),
  );
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("data-protection health cron route", () => {
  it("fails closed when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/data-protection-health"));
    expect(response.status).toBe(500);
    expect(db.listWorkspacesSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/data-protection-health", {
      headers: { authorization: "Bearer wrong-secret" },
    }));
    expect(response.status).toBe(401);
  });

  it("evaluates every active workspace and returns 200 when all are healthy", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/data-protection-health", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(200);
    expect(services.evaluateDataProtectionHealthSync).toHaveBeenCalledWith({ workspaceId: "default" });
    expect(services.evaluateDataProtectionHealthSync).toHaveBeenCalledWith({ workspaceId: "ws-2" });
    expect(services.sendExternalPagerAlert).not.toHaveBeenCalled();
    const body = (await response.json()) as { workspaceCount: number; workspaces: Array<{ workspaceId: string }> };
    expect(body.workspaceCount).toBe(2);
    expect(body.workspaces.map((w) => w.workspaceId)).toEqual(["default", "ws-2"]);
  });

  it("returns 503 when any workspace has an error-level alert", async () => {
    process.env.CRON_SECRET = "expected-secret";
    services.evaluateDataProtectionHealthSync.mockImplementation((options: { workspaceId?: string }) => {
      if (options?.workspaceId === "ws-2") {
        return {
          ...healthyHealth("ws-2"),
          alerts: [{ code: "workspace_head_age", severity: "error", message: "stale head" }],
        };
      }
      return healthyHealth(options?.workspaceId ?? "default");
    });

    const response = await GET(new Request("http://localhost/api/cron/data-protection-health", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(503);
    expect(services.sendExternalPagerAlert).toHaveBeenCalledTimes(1);
    expect(services.sendExternalPagerAlert).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-2",
      alerts: [expect.objectContaining({ severity: "error" })],
    }));
  });
});
