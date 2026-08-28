import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({ fireWorkflowEventSync: vi.fn() }));
vi.mock("@dofe-agent/services", () => services);

import { POST } from "./route";

const originalSecret = process.env.CRON_SECRET;

describe("workflow event ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.fireWorkflowEventSync.mockReturnValue({ matchedTriggerIds: ["trigger-1"], createdRunIds: ["run-1"], deduplicatedTriggerIds: [] });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("fails closed when the shared internal secret is unavailable", async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(request("expected"));
    expect(response.status).toBe(500);
    expect(services.fireWorkflowEventSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await POST(request("wrong"));
    expect(response.status).toBe(401);
    expect(services.fireWorkflowEventSync).not.toHaveBeenCalled();
  });

  it("materializes matching workflow triggers without returning event input", async () => {
    process.env.CRON_SECRET = "expected";
    const response = await POST(request("expected"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matched: 1, created: 1, deduplicated: 0 });
    expect(services.fireWorkflowEventSync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      eventName: "task.completed",
      eventId: "event-1",
    }));
  });
});

function request(secret: string): Request {
  return new Request("http://localhost/api/internal/workflows/events", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "workspace-1", eventName: "task.completed", eventId: "event-1", input: { taskId: "task-1" } }),
  });
}
