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
});
