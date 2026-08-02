import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockReadAuthorization,
  mockRecordAudit,
  mockReadTaskForDaemon,
  mockRequireDaemonAuth,
} = vi.hoisted(() => ({
  mockReadAuthorization: vi.fn(),
  mockRecordAudit: vi.fn(),
  mockReadTaskForDaemon: vi.fn(),
  mockRequireDaemonAuth: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  getDatabase: () => ({}),
  readMcpTaskAuditAuthorizationSync: mockReadAuthorization,
  recordMcpToolAuditSync: mockRecordAudit,
  withTransaction: (_db: unknown, work: () => unknown) => work(),
}));

vi.mock("../../../_lib/auth", () => ({
  readTaskForDaemon: mockReadTaskForDaemon,
  requireDaemonAuth: mockRequireDaemonAuth,
}));

import { POST } from "./route";

const audit = {
  taskId: "task-1",
  connectionId: "connection-1",
  toolName: "search",
  outcome: "succeeded" as const,
  eventId: "event-1",
};

describe("daemon MCP tool audit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireDaemonAuth.mockReturnValue({ workspaceId: "default" });
    mockReadTaskForDaemon.mockReturnValue({ id: "task-1", workspaceId: "default" });
    mockReadAuthorization.mockReturnValue({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authorizationJson: JSON.stringify({
        connections: [{ connectionId: "connection-1", approvedTools: ["search"] }],
      }),
    });
    mockRecordAudit.mockReturnValue({ id: "audit-1" });
  });

  it("returns explicit event acknowledgements after recording the whole batch", async () => {
    const response = await post([audit]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      recorded: 1,
      acceptedEventIds: ["event-1"],
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole batch when the persisted authorization grant is unavailable", async () => {
    mockReadAuthorization.mockReturnValue(null);

    const response = await post([audit]);

    expect(response.status).toBe(422);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("rejects the whole batch when any event is not authorized", async () => {
    const response = await post([
      audit,
      { ...audit, eventId: "event-2", toolName: "delete" },
    ]);

    expect(response.status).toBe(422);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("rejects missing event ids instead of silently skipping them", async () => {
    const response = await post([{ ...audit, eventId: "" }]);

    expect(response.status).toBe(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

function post(audits: unknown[]): Promise<Response> {
  return POST(
    new Request("http://localhost/api/daemon/tasks/task-1/mcp-tool-audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audits }),
    }),
    { params: Promise.resolve({ taskId: "task-1" }) },
  );
}
