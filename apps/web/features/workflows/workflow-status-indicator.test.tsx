import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowStatusIndicator, WORKFLOW_STATUS_ICON } from "@/features/workflows/workflow-status-indicator";

describe("WorkflowStatusIndicator", () => {
  it("renders an icon, visible text and an aria-label for the list/header view", () => {
    // UIUX:52/91：列表与页头状态此前只有文字+颜色，缺少图标与 aria-label。
    render(
      <WorkflowStatusIndicator
        className="workflow-run__node-status"
        label="执行中"
        status="running"
      />,
    );

    // 容器 aria-label：读屏一次性朗读完整状态，不依赖颜色或图形。
    const indicator = screen.getByLabelText("执行中");
    expect(indicator).toHaveAttribute("data-status", "running");
    expect(indicator).toHaveTextContent("执行中");

    // 状态图标（共享 AppIcon，aria-hidden，仅视觉强化）：渲染为 <svg>。
    const icon = indicator.querySelector(".workflow-status-indicator__icon") as SVGSVGElement | null;
    expect(icon).not.toBeNull();
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to a loader icon for unmapped statuses", () => {
    render(<WorkflowStatusIndicator label="未知" status="something_unmapped" />);
    const indicator = screen.getByLabelText("未知");
    expect(indicator.querySelector(".workflow-status-indicator__icon")).not.toBeNull();
  });

  it("maps both run-level and node-level statuses to a shared AppIcon", () => {
    // 运行级（created/succeeded…）与节点级（pending/retry_wait/skipped…）共用单一图标来源。
    expect(WORKFLOW_STATUS_ICON.created).toBe("calendar");
    expect(WORKFLOW_STATUS_ICON.succeeded).toBe("checkCircle");
    expect(WORKFLOW_STATUS_ICON["partially_succeeded"]).toBe("checkCircle");
    expect(WORKFLOW_STATUS_ICON.failed).toBe("alertCircle");
    expect(WORKFLOW_STATUS_ICON.waiting_approval).toBe("approvals");
    expect(WORKFLOW_STATUS_ICON.retry_wait).toBe("refresh");
    expect(WORKFLOW_STATUS_ICON.skipped).toBe("close");
    expect(WORKFLOW_STATUS_ICON.cancelled).toBe("stop");
    expect(WORKFLOW_STATUS_ICON.paused).toBe("stop");
  });
});
