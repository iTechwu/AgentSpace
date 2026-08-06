import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunPageData } from "./workflow-types";

const mocks = vi.hoisted(() => ({
  control: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./workflow-actions", () => ({ controlWorkflowRunAction: mocks.control }));

import { WorkflowRunClient, mergeWorkflowRunEvents } from "./workflow-run-client";

const initial: WorkflowRunPageData = {
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "每日审计",
  status: "running",
  triggerType: "schedule",
  currentSequence: 4,
  createdAt: "2026-08-06T00:00:00.000Z",
  nodes: [{
    id: "node-run-audit",
    nodeId: "audit",
    nodeType: "employee_task",
    employeeName: "审计员工",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    artifactCount: 0,
  }],
  events: [{ id: "event-4", sequence: 4, type: "workflow.node.started", severity: "info", createdAt: "2026-08-06T00:00:04.000Z" }],
};

describe("workflow run client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.control.mockResolvedValue({
      ok: true,
      data: { runId: "run-1", status: "paused" },
      invalidation: { workspaceId: "workspace-1", modules: ["automations"] },
    });
  });

  it("reconciles an event sequence gap before rendering newer state", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkflowRunClient data={initial} workspaceId="workspace-1" />);

    act(() => window.dispatchEvent(new CustomEvent("workflow-run-event", { detail: {
      id: "event-6",
      sequence: 6,
      type: "workflow.node.succeeded",
      severity: "info",
      createdAt: "2026-08-06T00:00:06.000Z",
    } })));

    expect(screen.getByText("正在同步缺失事件")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("after=4"), { cache: "no-store" });
    resolveFetch(Response.json({
      events: [
        { id: "event-5", sequence: 5, type: "workflow.node.queued", severity: "info", createdAt: "2026-08-06T00:00:05.000Z" },
        { id: "event-6", sequence: 6, type: "workflow.node.succeeded", severity: "info", createdAt: "2026-08-06T00:00:06.000Z" },
      ],
      hasMore: false,
      projection: { ...initial, currentSequence: 6, status: "running" },
    }));

    await waitFor(() => expect(screen.queryByText("正在同步缺失事件")).not.toBeInTheDocument());
    expect(screen.getByText("#6")).toBeVisible();
    expect(screen.getByText("运行中")).toBeVisible();
  });

  it("submits allowed run controls", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: initial })));
    render(<WorkflowRunClient data={initial} workspaceId="workspace-1" />);

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mocks.control).toHaveBeenCalledWith({ runId: "run-1", action: "pause", nodeId: undefined }));
  });

  it("detects gaps without applying out-of-order events", () => {
    const merged = mergeWorkflowRunEvents(initial.events, [{
      id: "event-6", sequence: 6, type: "workflow.node.succeeded", severity: "info", createdAt: "2026-08-06T00:00:06.000Z",
    }]);
    expect(merged).toEqual({ events: initial.events, gapAfter: 4 });
  });
});
