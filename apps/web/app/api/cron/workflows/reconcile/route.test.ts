import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  tickWorkflowSchedulerSync: vi.fn(),
  dispatchWorkflowOutboxBatchSync: vi.fn(),
  recoverStaleWorkflowWorkSync: vi.fn(),
}));
vi.mock("@dofe-agent/services", () => services);
import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  services.tickWorkflowSchedulerSync.mockReturnValue({ createdRunIds: ["run-1"], failedTriggerIds: ["trigger-1"] });
  services.dispatchWorkflowOutboxBatchSync.mockReturnValue({ dispatchedTaskIds: ["task-1"] });
  services.recoverStaleWorkflowWorkSync.mockReturnValue({
    readyNodeRunIds: ["node-1"],
    retriedNodeRunIds: [],
    failedNodeRunIds: [],
    orphanedTaskIds: [],
  });
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("workflow reconcile route", () => {
  it("fails closed without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile"));
    expect(response.status).toBe(500);
    expect(services.tickWorkflowSchedulerSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile", { headers: { authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401);
  });

  it("runs one bounded reconciliation tick", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile", { headers: { authorization: "Bearer expected" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduled: 1, schedulerFailures: 1, dispatched: 1, recovered: 1 });
    expect(services.tickWorkflowSchedulerSync).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });
});
