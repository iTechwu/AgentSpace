import { describe, expect, test } from "vitest";
import { validateWorkflowDraft } from "./workflow-client-validation";
import { createEmptyWorkflowDraft, workflowDraftReducer } from "./workflow-builder-reducer";

describe("workflowDraftReducer", () => {
  test("creates a parallel group with an explicit join and supports undo", () => {
    let state = createEmptyWorkflowDraft();
    state = workflowDraftReducer(state, { type: "addEmployeeNode", nodeId: "a", employeeId: "emp-a" });
    state = workflowDraftReducer(state, {
      type: "addParallelGroup",
      sourceNodeId: "a",
      branches: [{ id: "b", employeeId: "emp-b" }, { id: "c", employeeId: "emp-c" }],
      joinId: "join",
    });
    expect(validateWorkflowDraft(state).errors).toEqual([]);
    state = workflowDraftReducer(state, { type: "undo" });
    expect(state.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  test("keeps saved canonical state while preserving undo history", () => {
    let state = createEmptyWorkflowDraft();
    state = workflowDraftReducer(state, { type: "addEmployeeNode", nodeId: "a", employeeId: "emp-a" });
    state = workflowDraftReducer(state, { type: "markSaved", canonical: state, draftVersion: 3 });
    expect(state.dirty).toBe(false);
    expect(state.draftVersion).toBe(3);
    state = workflowDraftReducer(state, { type: "undo" });
    expect(state.nodes).toEqual([]);
    expect(state.dirty).toBe(true);
    state = workflowDraftReducer(state, { type: "redo" });
    expect(state.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(state.dirty).toBe(false);
  });

  test("caps structural history at fifty changes", () => {
    let state = createEmptyWorkflowDraft();
    for (let index = 0; index < 60; index += 1) {
      state = workflowDraftReducer(state, { type: "addEmployeeNode", nodeId: `node-${index}`, employeeId: `emp-${index}` });
    }
    expect(state.past).toHaveLength(50);
  });

  test("adds a configurable approval node to the same graph history", () => {
    let state = createEmptyWorkflowDraft();
    state = workflowDraftReducer(state, { type: "addEmployeeNode", nodeId: "draft", employeeId: "emp-a" });
    state = workflowDraftReducer(state, {
      type: "addApprovalNode",
      nodeId: "approve",
      employeeId: "emp-a",
      channelName: "项目审批群",
    });
    state = workflowDraftReducer(state, { type: "connect", source: "draft", target: "approve" });

    expect(state.nodes[1]).toEqual({
      id: "approve",
      type: "approval",
      config: { employeeId: "emp-a", channelName: "项目审批群", instruction: "请审批上游步骤的交付结果。" },
    });
    expect(validateWorkflowDraft(state).errors).toEqual([]);
  });
});
