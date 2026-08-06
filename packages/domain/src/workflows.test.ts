import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph, type WorkflowGraphDefinition } from "./workflows.ts";

const node = (
  id: string,
  type: "employee_task" | "join" | "approval",
  employeeId?: string,
) => ({ id, type, ...(employeeId ? { employeeId } : {}), config: {} });

test("accepts a parallel employee graph and preserves node input order in its topological order", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      node("A", "employee_task", "employee-a"),
      node("B", "employee_task", "employee-b"),
      node("C", "employee_task", "employee-c"),
      node("Join", "join"),
      node("D", "employee_task", "employee-d"),
    ],
    edges: [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "Join" },
      { source: "C", target: "Join" },
      { source: "Join", target: "D" },
    ],
  };

  assert.deepEqual(validateWorkflowGraph(graph), {
    errors: [],
    topologicalOrder: ["A", "B", "C", "Join", "D"],
  });
});

test("reports a cycle and a join with too few inputs without throwing", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [node("A", "employee_task", "employee-a"), node("Join", "join")],
    edges: [
      { source: "A", target: "Join" },
      { source: "Join", target: "A" },
    ],
  };

  const result = validateWorkflowGraph(graph);

  assert.ok(result.errors.some((error) => error.code === "workflow_graph_cycle"));
  assert.ok(result.errors.some((error) => error.code === "workflow_join_requires_multiple_inputs"));
  assert.deepEqual(result.topologicalOrder, []);
});

test("returns all local graph structure errors", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      node("duplicate", "employee_task"),
      node("duplicate", "approval"),
      node("join", "join"),
      node("isolated", "approval"),
    ],
    edges: [{ source: "duplicate", target: "missing" }],
  };

  const result = validateWorkflowGraph(graph);
  const codes = result.errors.map((error) => error.code);

  assert.ok(codes.includes("workflow_graph_duplicate_node_id"));
  assert.ok(codes.includes("workflow_graph_edge_endpoint_missing"));
  assert.ok(codes.includes("workflow_employee_task_requires_employee_id"));
  assert.ok(codes.includes("workflow_join_requires_multiple_inputs"));
  assert.ok(codes.includes("workflow_join_requires_downstream"));
  assert.ok(codes.includes("workflow_graph_isolated_node"));
});

test("rejects an acyclic component disconnected from the main workflow entry", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      node("a", "employee_task", "employee-a"),
      node("b", "employee_task", "employee-b"),
      node("c", "employee_task", "employee-c"),
      node("d", "employee_task", "employee-d"),
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "c", target: "d" },
    ],
  };

  const result = validateWorkflowGraph(graph);

  assert.ok(result.errors.some((error) => error.code === "workflow_graph_unreachable_node"));
  assert.deepEqual(
    result.errors.find((error) => error.code === "workflow_graph_unreachable_node")?.nodeIds,
    ["c"],
  );
});
