import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  eventPage: vi.fn(),
  runPage: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({ getCurrentWorkspaceContext: mocks.context }));
vi.mock("@/features/workflows/workflow-data", () => ({
  getWorkflowRunEventsPage: mocks.eventPage,
  getWorkflowRunPageData: mocks.runPage,
}));

import { GET } from "./route";

const routeContext = { params: Promise.resolve({ workspaceId: "workspace-1", runId: "run-1" }) };

describe("workflow run events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      currentWorkspace: { id: "workspace-1" },
      currentUser: { id: "user-1" },
      currentMembership: { role: "member" },
      accessScope: "workspace",
    });
    mocks.eventPage.mockReturnValue({
      events: [{ id: "event-5", sequence: 5, type: "workflow.node.succeeded", severity: "info", createdAt: "2026-08-06T00:00:00.000Z" }],
      hasMore: false,
    });
    mocks.runPage.mockReturnValue({ id: "run-1", status: "running", nodes: [], events: [] });
  });

  it("returns ordered incremental events and the latest projection", async () => {
    const response = await GET(new Request("http://localhost/api/events?after=4"), routeContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [{ sequence: 5 }], hasMore: false, projection: { status: "running" } });
    expect(mocks.eventPage).toHaveBeenCalledWith("workspace-1", "run-1", 4);
  });

  it("rejects cross-workspace and invalid sequence requests", async () => {
    const forbidden = await GET(new Request("http://localhost/api/events?after=0"), {
      params: Promise.resolve({ workspaceId: "workspace-2", runId: "run-1" }),
    });
    expect(forbidden.status).toBe(403);

    const invalid = await GET(new Request("http://localhost/api/events?after=-1"), routeContext);
    expect(invalid.status).toBe(400);
    expect(mocks.eventPage).not.toHaveBeenCalled();
  });

  it("does not expose a run from another workspace", async () => {
    mocks.eventPage.mockReturnValue(null);
    const response = await GET(new Request("http://localhost/api/events?after=0"), routeContext);
    expect(response.status).toBe(404);
    expect(mocks.runPage).not.toHaveBeenCalled();
  });
});
