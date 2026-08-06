import { useReducer, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkflowCanvas } from "./workflow-canvas";
import { createWorkflowDraftState, workflowDraftReducer } from "./workflow-builder-reducer";

const EMPLOYEES = [{ id: "emp-a", name: "AI 员工步骤" }];
const flowMocks = vi.hoisted(() => ({ fitView: vi.fn() }));

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children, onInit }: { children: React.ReactNode; onInit?: (instance: unknown) => void }) => {
    onInit?.({ fitView: flowMocks.fitView });
    return <div data-testid="react-flow">{children}</div>;
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}));

function WorkflowCanvasHarness() {
  const [state, dispatch] = useReducer(
    workflowDraftReducer,
    createWorkflowDraftState({
      schemaVersion: 1,
      nodes: [{ id: "summary", type: "join", config: { policy: "all_success" } }],
      edges: [],
    }, 1),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  return (
    <WorkflowCanvas
      employees={EMPLOYEES}
      graph={state}
      onEvent={dispatch}
      onSelectNode={setSelectedNodeId}
      selectedNodeId={selectedNodeId}
    />
  );
}

describe("WorkflowCanvas", () => {
  it("refits the canvas after the workflow topology changes", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const user = userEvent.setup();
    render(<WorkflowCanvasHarness />);
    flowMocks.fitView.mockClear();

    await user.click(screen.getByRole("button", { name: "添加 AI 员工步骤" }));
    await user.selectOptions(screen.getByLabelText("AI 员工"), "emp-a");
    await user.click(screen.getByRole("button", { name: "添加" }));

    expect(flowMocks.fitView).toHaveBeenCalledWith({ duration: 200, padding: 0.2 });
    flowMocks.fitView.mockClear();
    window.dispatchEvent(new Event("resize"));
    expect(flowMocks.fitView).toHaveBeenCalledWith({ duration: 200, padding: 0.2 });
    vi.unstubAllGlobals();
  });

  it("adds and connects nodes without drag and drop", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvasHarness />);
    await user.click(screen.getByRole("button", { name: "添加 AI 员工步骤" }));
    await user.selectOptions(screen.getByLabelText("AI 员工"), "emp-a");
    await user.click(screen.getByRole("button", { name: "添加" }));
    await user.selectOptions(screen.getByLabelText("连接到"), "summary");
    await user.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByRole("list", { name: "流程结构" })).toHaveTextContent("AI 员工步骤");
    expect(screen.getByRole("list", { name: "流程结构" })).toHaveTextContent("汇总步骤");
  });

  it("marks invalid nodes in the list alternative", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvasHarness />);
    await user.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByTestId("node-summary")).toBeVisible();
  });
});
