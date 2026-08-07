import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reconciliation = vi.hoisted(() => ({
  runCommitReconciliationStage: vi.fn(),
}));
vi.mock("@/app/api/daemon/_lib/commit-reconciliation", () => reconciliation);
import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  reconciliation.runCommitReconciliationStage.mockReturnValue({ committed: 1, retried: 2, rolledBack: 0, skipped: 3 });
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("task commit reconcile route", () => {
  it("fails closed without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/task-commit-reconcile"));
    expect(response.status).toBe(500);
    expect(reconciliation.runCommitReconciliationStage).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await GET(new Request("http://localhost/api/cron/task-commit-reconcile", {
      headers: { authorization: "Bearer wrong" },
    }));
    expect(response.status).toBe(401);
  });

  it("runs one bounded commit reconciliation stage", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await GET(new Request("http://localhost/api/cron/task-commit-reconcile", {
      headers: { authorization: "Bearer expected" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ committed: 1, retried: 2, rolledBack: 0, skipped: 3 });
    expect(reconciliation.runCommitReconciliationStage).toHaveBeenCalledOnce();
  });
});
