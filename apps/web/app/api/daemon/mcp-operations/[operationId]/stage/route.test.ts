import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockReadMcpOperationForDaemon,
  mockRequireDaemonAuth,
  mockUpdateMcpOperationStage,
} = vi.hoisted(() => ({
  mockReadMcpOperationForDaemon: vi.fn(),
  mockRequireDaemonAuth: vi.fn(),
  mockUpdateMcpOperationStage: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  updateMcpOperationStageSync: mockUpdateMcpOperationStage,
}));

vi.mock("../../../_lib/auth", () => ({
  readMcpOperationForDaemon: mockReadMcpOperationForDaemon,
  requireDaemonAuth: mockRequireDaemonAuth,
}));

import { POST } from "./route";

describe("daemon MCP operation stage route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireDaemonAuth.mockReturnValue({ workspaceId: "workspace-1" });
    mockReadMcpOperationForDaemon.mockReturnValue({ id: "operation-1" });
    mockUpdateMcpOperationStage.mockReturnValue({ id: "operation-1", status: "running", stage: "discovering_tools" });
  });

  it("updates an authenticated operation in the daemon workspace", async () => {
    const response = await post({ stage: "discovering_tools" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: { id: "operation-1", status: "running", stage: "discovering_tools" },
    });
    expect(mockUpdateMcpOperationStage).toHaveBeenCalledWith({
      operationId: "operation-1",
      workspaceId: "workspace-1",
      stage: "discovering_tools",
    });
  });

  it("rejects unknown stages before writing", async () => {
    const response = await post({ stage: "downloading_secrets" });

    expect(response.status).toBe(400);
    expect(mockUpdateMcpOperationStage).not.toHaveBeenCalled();
  });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/daemon/mcp-operations/operation-1/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ operationId: "operation-1" }) },
  );
}
