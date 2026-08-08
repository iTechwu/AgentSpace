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
  services.tickWorkflowSchedulerSync.mockReturnValue({ createdRunIds: ["run-1"], failedTriggerIds: ["trigger-1"], expiredApprovalFailures: [], approvalScanFailure: null, invalidClock: false });
  services.dispatchWorkflowOutboxBatchSync.mockReturnValue({ dispatchedTaskIds: ["task-1"] });
  services.recoverStaleWorkflowWorkSync.mockReturnValue({
    readyNodeRunIds: ["node-1"],
    retriedNodeRunIds: [],
    failedNodeRunIds: [],
    orphanedTaskIds: [],
    requeuedReadyNodeRunIds: [],
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

  it("counts approval expiry failures and whole-scan failures in schedulerFailures", async () => {
    // schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败
    // 与整轮扫描失败都必须计入，否则生产监控会把审批失败报告为 0。
    process.env.CRON_SECRET = "expected";
    services.tickWorkflowSchedulerSync.mockReturnValue({
      createdRunIds: [],
      failedTriggerIds: [],
      expiredApprovalFailures: [{ approvalId: "a-1" }, { approvalId: "a-2" }],
      approvalScanFailure: { errorCode: "workflow_approval_scan_failed", occurredAt: "2026-08-07T00:00:00.000Z" },
      invalidClock: false,
    });
    const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile", { headers: { authorization: "Bearer expected" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    // 0 触发器失败 + 2 审批限时失败 + 1 整轮扫描失败 = 3。
    expect(body.schedulerFailures).toBe(3);
  });

  it("reports an invalid clock in schedulerFailures and skips outbox/recovery", async () => {
    // 非法时钟：reconcile 必须把 invalidClock 计入 schedulerFailures 并提前返回，
    // 不再调用同样依赖 now 的 outbox/recovery，避免非结构化异常中断整轮。
    process.env.CRON_SECRET = "expected";
    services.tickWorkflowSchedulerSync.mockReturnValue({ invalidClock: true });
    const response = await GET(new Request("http://localhost/api/cron/workflows/reconcile", { headers: { authorization: "Bearer expected" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduled: 0, schedulerFailures: 1, dispatched: 0, recovered: 0 });
    expect(services.dispatchWorkflowOutboxBatchSync).not.toHaveBeenCalled();
    expect(services.recoverStaleWorkflowWorkSync).not.toHaveBeenCalled();
  });
});
