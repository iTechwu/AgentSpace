import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  defaultRuntimeMaintenanceDependencies: {},
  runRuntimeMaintenanceAsync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => services);

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;
const successfulMaintenanceResult = {
  ok: true,
  status: "succeeded",
  runId: "maintenance-1",
  evidence: { status: "succeeded" },
  stages: {
    provisioning: { status: "succeeded", value: { driven: 2 } },
    cleanup: { status: "succeeded", value: { staleFailed: 1 } },
    usageRetries: { status: "succeeded", value: { processedCount: 1 } },
    usageReconciliation: { status: "succeeded", value: { reconciledCount: 3 } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  services.runRuntimeMaintenanceAsync.mockResolvedValue(successfulMaintenanceResult);
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("runtime provisioning maintenance route", () => {
  it("fails closed when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning"));
    expect(response.status).toBe(500);
    expect(services.runRuntimeMaintenanceAsync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer wrong-secret" },
    }));
    expect(response.status).toBe(401);
  });

  it("runs MCP housekeeping and maintenance in local mode", async () => {
    process.env.CRON_SECRET = "expected-secret";

    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer expected-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successfulMaintenanceResult);
    expect(services.runRuntimeMaintenanceAsync).toHaveBeenCalledOnce();
  });

  it("resumes provisioning and cleanup work for an authorized scheduler", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successfulMaintenanceResult);
    expect(services.runRuntimeMaintenanceAsync).toHaveBeenCalledOnce();
  });

  it("returns a retryable status when any maintenance stage fails", async () => {
    process.env.CRON_SECRET = "expected-secret";
    services.runRuntimeMaintenanceAsync.mockResolvedValue({
      ...successfulMaintenanceResult,
      ok: false,
      status: "partial_failure",
      stages: {
        ...successfulMaintenanceResult.stages,
        usageReconciliation: { status: "failed", error: "models unavailable" },
      },
    });
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer expected-secret" },
    }));

    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });
});
