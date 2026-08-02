import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  listWorkspacesSync: vi.fn(),
}));
const services = vi.hoisted(() => ({
  runBackupRestoreDrillRunSync: vi.fn(),
  notifyWorkspaceAdminsSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => db);
vi.mock("@dofe-agent/services", () => services);

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

function drillRun(workspaceId: string, status: "completed" | "failed") {
  return {
    id: `drill-${workspaceId}`,
    workspaceId,
    drillType: "metadata",
    trigger: "cron",
    status,
    startedAt: "2026-08-02T00:00:00.000Z",
    sampleCount: 1,
    successCount: status === "completed" ? 1 : 0,
    failureCount: status === "completed" ? 0 : 1,
    resultJson: "{}",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listWorkspacesSync.mockReturnValue([
    { id: "default", slug: "default", name: "Dofe Agent", createdBy: "", createdAt: "", updatedAt: "" },
    { id: "ws-2", slug: "ws-2", name: "Tenant 2", createdBy: "", createdAt: "", updatedAt: "" },
  ]);
  services.runBackupRestoreDrillRunSync.mockImplementation((options: { workspaceId?: string }) =>
    drillRun(options?.workspaceId ?? "default", "completed"),
  );
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("backup-recovery drill cron route", () => {
  it("fails closed when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new Request("http://localhost/api/cron/backup-recovery-drill"));
    expect(response.status).toBe(500);
    expect(db.listWorkspacesSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/backup-recovery-drill", {
      headers: { authorization: "Bearer wrong-secret" },
    }));
    expect(response.status).toBe(401);
  });

  it("runs the drill for every active workspace and returns 200 when all pass", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const response = await GET(new Request("http://localhost/api/cron/backup-recovery-drill", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(200);
    expect(services.runBackupRestoreDrillRunSync).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default", trigger: "cron" }),
    );
    expect(services.runBackupRestoreDrillRunSync).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-2", trigger: "cron" }),
    );
    expect(services.notifyWorkspaceAdminsSync).not.toHaveBeenCalled();
  });

  it("returns 503 and notifies admins when any workspace fails", async () => {
    process.env.CRON_SECRET = "expected-secret";
    services.runBackupRestoreDrillRunSync.mockImplementation((options: { workspaceId?: string }) => {
      const workspaceId = options?.workspaceId ?? "default";
      return drillRun(workspaceId, workspaceId === "ws-2" ? "failed" : "completed");
    });

    const response = await GET(new Request("http://localhost/api/cron/backup-recovery-drill", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    expect(response.status).toBe(503);
    expect(services.notifyWorkspaceAdminsSync).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-2", resourceType: "data_protection" }),
    );
  });
});
