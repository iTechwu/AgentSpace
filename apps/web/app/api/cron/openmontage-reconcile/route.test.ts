import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReconcile = vi.hoisted(() => vi.fn());

vi.mock("@dofe-agent/services", () => ({
  reconcileSyncingOpenMontageJobsAsync: mockReconcile,
}));

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

describe("OpenMontage reconciliation cron route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    mockReconcile.mockReset();
    mockReconcile.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("rejects an invalid scheduler credential", async () => {
    const response = await GET(new Request("http://localhost/api/cron/openmontage-reconcile", {
      headers: { authorization: "Bearer wrong" },
    }));

    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("reconciles syncing Jobs for an authorized scheduler", async () => {
    const response = await GET(new Request("http://localhost/api/cron/openmontage-reconcile", {
      headers: { authorization: "Bearer cron-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(mockReconcile).toHaveBeenCalledWith({ limit: 50 });
  });

  it("returns a retryable status when any Job remains unreconciled", async () => {
    mockReconcile.mockResolvedValue({ attempted: 2, succeeded: 1, failed: 1 });

    const response = await GET(new Request("http://localhost/api/cron/openmontage-reconcile", {
      headers: { authorization: "Bearer cron-secret" },
    }));

    expect(response.status).toBe(503);
  });
});
