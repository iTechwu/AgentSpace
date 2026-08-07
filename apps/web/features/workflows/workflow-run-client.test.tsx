import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { WorkflowRunPageData } from "./workflow-types";

const mocks = vi.hoisted(() => ({
  control: vi.fn(),
  run: vi.fn(),
  rerun: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));
vi.mock("./workflow-actions", () => ({
  controlWorkflowRunAction: mocks.control,
  runWorkflowAction: mocks.run,
  rerunWorkflowRunAction: mocks.rerun,
}));

import { WorkflowRunClient, mergeWorkflowRunEvents, selectLatestWorkflowProjection } from "./workflow-run-client";

const initial: WorkflowRunPageData = {
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "每日审计",
  status: "running",
  triggerType: "schedule",
  currentSequence: 4,
  canControl: true,
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

function renderRun(data: WorkflowRunPageData = initial): void {
  render(
    <LanguageProvider initialLanguage="zh">
      <WorkflowRunClient data={data} workspaceId="workspace-1" workspaceSlug="default" />
    </LanguageProvider>,
  );
}

describe("workflow run client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 取消运行与重试步骤现已加 window.confirm 二次确认，测试默认放行。
    vi.stubGlobal("confirm", vi.fn(() => true));
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
    renderRun();

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
    renderRun();

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mocks.control).toHaveBeenCalledWith({ runId: "run-1", action: "pause", nodeId: undefined }));
  });

  it("aborts cancelling a run when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: initial })));
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderRun();

    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toBeEnabled());
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it("renders approval waiting detail with a link to the approval center", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: initial })));
    const withApproval: WorkflowRunPageData = {
      ...initial,
      status: "waiting_approval",
      nodes: [...initial.nodes, {
        id: "node-run-approval",
        nodeId: "approval",
        nodeType: "approval",
        employeeName: "审批节点",
        status: "waiting_approval",
        attemptCount: 1,
        maxAttempts: 1,
        artifactCount: 0,
        approvalId: "approval-1",
        approvalRisk: "high",
        approvalReviewerLabel: "审批人甲",
        approvalSource: "工作流审批",
      }],
    };
    renderRun(withApproval);

    const link = screen.getByRole("link", { name: "前往审批中心" });
    expect(link).toHaveAttribute("href", "/w/default/approvals?focus=approval-1");
    expect(screen.getByText("审批人：审批人甲")).toBeInTheDocument();
    expect(screen.getByText(/风险：高/)).toBeInTheDocument();
  });

  it("offers a rerun action for terminal runs and replays by run id", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: initial })));
    mocks.rerun.mockResolvedValue({ ok: true, data: { runId: "run-2" }, invalidation: { workspaceId: "workspace-1", modules: ["automations"] } });
    // 即便是定时触发的运行（triggerType: schedule），只要已终结即可重跑。
    const terminal: WorkflowRunPageData = { ...initial, status: "succeeded", canRerun: true };
    renderRun(terminal);

    const rerunButton = screen.getByRole("button", { name: "重新运行" });
    await user.click(rerunButton);
    // 重跑按原运行 id 回放（复用原版本与输入快照），而非按工作流新建空输入运行。
    await waitFor(() => expect(mocks.rerun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" })));
    // 重跑成功后应跳转到新运行，而非停留在旧运行。
    expect(mocks.push).toHaveBeenCalledWith("/w/default/automations/runs/run-2");
  });

  it("allows a workflow waiting for approval to be paused", async () => {
    const user = userEvent.setup();
    const waiting: WorkflowRunPageData = { ...initial, status: "waiting_approval" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: waiting })));
    renderRun(waiting);

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(mocks.control).toHaveBeenCalledWith({ runId: "run-1", action: "pause", nodeId: undefined }));
  });

  it("detects gaps without applying out-of-order events", () => {
    const merged = mergeWorkflowRunEvents(initial.events, [{
      id: "event-6", sequence: 6, type: "workflow.node.succeeded", severity: "info", createdAt: "2026-08-06T00:00:06.000Z",
    }]);
    expect(merged).toEqual({ events: initial.events, gapAfter: 4 });
  });

  it("does not replace a newer projection with a stale polling response", () => {
    const current = { ...initial, currentSequence: 6, status: "succeeded" as const };
    const stale = { ...initial, currentSequence: 5, status: "running" as const };
    const sameSequenceStaleRequest = { ...initial, currentSequence: 6, status: "running" as const };

    expect(selectLatestWorkflowProjection(current, stale)).toBe(current);
    expect(selectLatestWorkflowProjection(stale, current)).toBe(current);
    expect(selectLatestWorkflowProjection(current, sameSequenceStaleRequest, 2, 1)).toBe(current);
  });

  it("allows a manual retry after automatic attempts are exhausted", async () => {
    const user = userEvent.setup();
    const failed: WorkflowRunPageData = {
      ...initial,
      status: "failed",
      nodes: [{
        ...initial.nodes[0],
        status: "failed",
        attemptCount: 3,
        maxAttempts: 3,
        errorCode: "workflow_task_failed",
      }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], hasMore: false, projection: failed })));
    renderRun(failed);

    expect(screen.getByText("步骤执行失败")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试步骤" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "重试步骤" }));

    await waitFor(() => expect(mocks.control).toHaveBeenCalledWith({
      runId: "run-1",
      action: "retry_node",
      nodeId: "audit",
    }));
  });

  it("allows a failed branch to be retried after a partial-success join", () => {
    const partial: WorkflowRunPageData = {
      ...initial,
      status: "partially_succeeded",
      nodes: [{ ...initial.nodes[0], status: "failed", attemptCount: 3, maxAttempts: 3 }],
    };

    renderRun(partial);

    expect(screen.getByRole("button", { name: "重试步骤" })).toBeVisible();
  });

  it("requires manual compensation instead of retrying uncertain external effects", () => {
    renderRun({
      ...initial,
      status: "failed",
      nodes: [{ ...initial.nodes[0], status: "failed", errorCode: "workflow_completion_effect_uncertain" }],
    });

    expect(screen.getByText("外部操作状态不确定，请先检查并补偿")).toBeVisible();
    expect(screen.queryByRole("button", { name: "重试步骤" })).not.toBeInTheDocument();
  });

  it("does not render run controls for read-only members", () => {
    renderRun({ ...initial, canControl: false });

    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });
});
