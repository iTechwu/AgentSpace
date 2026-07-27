import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  resumePendingProvisioningTasksAsync: vi.fn(),
  resumeManagedRuntimeCleanupRequestsAsync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => services);

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  services.resumePendingProvisioningTasksAsync.mockResolvedValue({ driven: 2 });
  services.resumeManagedRuntimeCleanupRequestsAsync.mockResolvedValue({ staleFailed: 1 });
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
    expect(services.resumePendingProvisioningTasksAsync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer wrong-secret" },
    }));
    expect(response.status).toBe(401);
  });

  it("resumes provisioning and cleanup work for an authorized scheduler", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/runtime-provisioning", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      provisioning: { driven: 2 },
      cleanup: { staleFailed: 1 },
    });
    expect(services.resumePendingProvisioningTasksAsync).toHaveBeenCalledOnce();
    expect(services.resumeManagedRuntimeCleanupRequestsAsync).toHaveBeenCalledOnce();
  });
});
