import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  defaultRuntimeMaintenanceDependencies: {
    flushSlo: vi.fn(),
    pageSlo: vi.fn(),
  },
}));

vi.mock("@dofe-agent/services/runtime", () => services);

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "expected-secret";
  services.defaultRuntimeMaintenanceDependencies.flushSlo.mockResolvedValue([{ domain: "task-queue" }]);
  services.defaultRuntimeMaintenanceDependencies.pageSlo.mockResolvedValue({ sent: false, reason: "not configured" });
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("Prisma cutover SLO cron route", () => {
  it("requires the cron secret", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/prisma-cutover-slo"));
    expect(response.status).toBe(500);
  });

  it("flushes before paging for an authorized scheduler", async () => {
    const response = await GET(new Request("http://localhost/api/cron/prisma-cutover-slo", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(200);
    expect(services.defaultRuntimeMaintenanceDependencies.flushSlo).toHaveBeenCalledOnce();
    expect(services.defaultRuntimeMaintenanceDependencies.pageSlo).toHaveBeenCalledOnce();
  });

  it("returns retryable failure when either stage throws", async () => {
    services.defaultRuntimeMaintenanceDependencies.pageSlo.mockRejectedValue(new Error("pager unavailable"));
    const response = await GET(new Request("http://localhost/api/cron/prisma-cutover-slo", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("pager unavailable");
  });
});
