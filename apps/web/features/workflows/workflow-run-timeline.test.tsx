import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import type { WorkflowRunEventItem } from "./workflow-types";

function event(type: string, sequence: number): WorkflowRunEventItem {
  return { id: `evt-${sequence}`, sequence, type, severity: "info", createdAt: "2026-08-07T01:00:00.000Z" };
}

describe("WorkflowRunTimeline", () => {
  it("maps engine run/node/join/approval event codes to specific labels", () => {
    render(
      <WorkflowRunTimeline
        events={[
          event("run.created", 1),
          event("run.started", 2),
          event("node.started", 3),
          event("node.succeeded", 4),
          event("join.succeeded", 5),
          event("approval.requested", 6),
          event("run.partially_succeeded", 7),
          event("run.failed", 8),
        ]}
      />,
    );

    // 每个引擎事件码都应映射到具体文案，而非走到通用兜底“工作流状态已更新”。
    expect(screen.getByText("运行已创建")).toBeInTheDocument();
    expect(screen.getByText("运行已开始")).toBeInTheDocument();
    expect(screen.getByText("步骤开始执行")).toBeInTheDocument();
    expect(screen.getByText("步骤执行完成")).toBeInTheDocument();
    expect(screen.getByText("汇聚完成")).toBeInTheDocument();
    expect(screen.getByText("审批已发起")).toBeInTheDocument();
    expect(screen.getByText("运行部分完成")).toBeInTheDocument();
    expect(screen.getByText("运行失败")).toBeInTheDocument();
    expect(screen.queryByText("工作流状态已更新")).toBeNull();
  });

  it("falls back to a generic label for unknown event codes", () => {
    render(<WorkflowRunTimeline events={[event("workflow.run.created", 1)]} />);
    // workflow.* 是 outbox 命名空间，不属于运行事件日志，应走兜底。
    expect(screen.getByText("工作流状态已更新")).toBeInTheDocument();
  });
});
