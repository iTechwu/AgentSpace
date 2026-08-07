import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  runsPage: vi.fn(),
  decodeCursor: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({ getCurrentWorkspaceContext: mocks.context }));
vi.mock("@/features/workflows/workflow-data", () => ({
  getWorkflowRunsPageSync: mocks.runsPage,
  decodeWorkflowRunCursor: mocks.decodeCursor,
}));

import { GET } from "./route";

const routeContext = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

describe("workflow runs pagination route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      currentWorkspace: { id: "workspace-1" },
      currentUser: { id: "user-1" },
      currentMembership: { role: "member" },
      accessScope: "workspace",
    });
    mocks.decodeCursor.mockReturnValue({ createdAt: "2026-08-06T00:00:00.000Z", id: "run-0" });
    mocks.runsPage.mockReturnValue({
      runs: [{ id: "run-1", workflowId: "wf-1", workflowName: "每日简报", status: "succeeded", triggerType: "schedule", createdAt: "2026-08-06T00:00:00.000Z" }],
      total: 51,
      hasMore: true,
      nextCursor: "next-cursor-token",
    });
  });

  it("returns a cursor-paginated runs page for workspace members", async () => {
    const response = await GET(new Request("http://localhost/api/workflows/runs?limit=50&cursor=abc"), routeContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 51, hasMore: true, nextCursor: "next-cursor-token" });
    expect(mocks.runsPage).toHaveBeenCalledWith("workspace-1", { limit: 50, cursor: "abc" });
  });

  it("passes null cursor for the first page when no cursor is supplied", async () => {
    await GET(new Request("http://localhost/api/workflows/runs?limit=50"), routeContext);
    expect(mocks.runsPage).toHaveBeenCalledWith("workspace-1", { limit: 50, cursor: null });
  });

  it("rejects cross-workspace and channel-scoped access", async () => {
    const forbidden = await GET(new Request("http://localhost/api/workflows/runs"), {
      params: Promise.resolve({ workspaceId: "workspace-2" }),
    });
    expect(forbidden.status).toBe(403);

    mocks.context.mockResolvedValueOnce({
      currentWorkspace: { id: "workspace-1" },
      currentUser: { id: "user-1" },
      currentMembership: { role: "member" },
      accessScope: "channel",
    });
    const channelScoped = await GET(new Request("http://localhost/api/workflows/runs"), routeContext);
    expect(channelScoped.status).toBe(403);
    expect(mocks.runsPage).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests and invalid pagination", async () => {
    mocks.context.mockResolvedValue(null);
    const unauth = await GET(new Request("http://localhost/api/workflows/runs"), routeContext);
    expect(unauth.status).toBe(401);

    mocks.context.mockResolvedValue({
      currentWorkspace: { id: "workspace-1" },
      currentUser: { id: "user-1" },
      currentMembership: { role: "member" },
      accessScope: "workspace",
    });
    const invalidLimit = await GET(new Request("http://localhost/api/workflows/runs?limit=-5"), routeContext);
    expect(invalidLimit.status).toBe(400);
    expect(mocks.runsPage).not.toHaveBeenCalled();

    // 非法游标（无法解码）返回 400，不静默回首页，避免分页错位被掩盖。
    mocks.decodeCursor.mockReturnValueOnce(null);
    const invalidCursor = await GET(new Request("http://localhost/api/workflows/runs?limit=50&cursor=garbled"), routeContext);
    expect(invalidCursor.status).toBe(400);
    expect(mocks.runsPage).not.toHaveBeenCalled();
  });

  it("clamps limit to the maximum page size", async () => {
    await GET(new Request("http://localhost/api/workflows/runs?limit=9999&cursor=abc"), routeContext);
    expect(mocks.runsPage).toHaveBeenCalledWith("workspace-1", { limit: 200, cursor: "abc" });
  });
});
