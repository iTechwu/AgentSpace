import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { WorkflowRunFlowchart } from "@/features/workflows/workflow-run-flowchart";
import type { WorkflowNodeRunItem } from "@/features/workflows/workflow-types";

// ReactFlow 在 jsdom 下无法真实测量/布局；这里把 mock 改为渲染每个节点的 data.label
// 与 ariaLabel，使流程图可访问性（图标 + 节点 aria-label + 状态文字）可被断言。
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes }: { nodes: Array<{ id: string; ariaLabel?: string; data?: { label?: ReactNode } }> }) => (
    <div data-testid="react-flow">
      {nodes.map((node) => (
        <div key={node.id} aria-label={node.ariaLabel} data-testid={`flow-node-${node.id}`}>
          {node.data?.label}
        </div>
      ))}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
}));

const NODES: WorkflowNodeRunItem[] = [
  { id: "n1", nodeId: "a", nodeType: "employee_task", employeeName: "Atlas", status: "succeeded", attemptCount: 1, maxAttempts: 1, artifactCount: 0 },
  { id: "n2", nodeId: "b", nodeType: "approval", employeeName: "", status: "waiting_approval", attemptCount: 1, maxAttempts: 1, artifactCount: 0 },
  { id: "n3", nodeId: "c", nodeType: "employee_task", employeeName: "Nova", status: "failed", attemptCount: 1, maxAttempts: 1, artifactCount: 0 },
];
const EDGES = [{ source: "a", target: "b" }, { source: "b", target: "c" }];
const tx = (zh: string) => zh;

describe("WorkflowRunFlowchart accessibility", () => {
  it("renders a status icon, status text and a node-level aria-label for every node", () => {
    render(<WorkflowRunFlowchart nodes={NODES} edges={EDGES} tx={tx} />);

    // 节点级 aria-label（UIUX:91）：读屏可一次朗读「名称，状态」，不依赖颜色或图形。
    const succeeded = screen.getByTestId("flow-node-a");
    expect(succeeded).toHaveAttribute("aria-label", "Atlas，成功");
    expect(succeeded).toHaveTextContent("成功");

    // 状态图标（aria-hidden，仅视觉强化）：成功 → ✓。
    const icon = succeeded.querySelector(".workflow-run-flow-node__icon") as HTMLElement | null;
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.textContent).toBe("✓");

    // 审批等待节点：无员工名时回退到节点类型，aria-label 仍含状态。
    const waiting = screen.getByTestId("flow-node-b");
    expect(waiting).toHaveAttribute("aria-label", "approval，待审批");

    // 失败节点图标 → ✕。
    const failed = screen.getByTestId("flow-node-c");
    const failedIcon = failed.querySelector(".workflow-run-flow-node__icon") as HTMLElement | null;
    expect(failedIcon?.textContent).toBe("✕");
  });
});
