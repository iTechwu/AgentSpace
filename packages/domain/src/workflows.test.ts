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

  assert.ok(result.errors.some((error) => error.code === "workflow_node_unreachable"));
  assert.deepEqual(
    result.errors.find((error) => error.code === "workflow_node_unreachable")?.nodeIds,
    ["c"],
  );
});

test("requires at least one employee task", () => {
  for (const graph of [
    { schemaVersion: 1, nodes: [], edges: [] },
    { schemaVersion: 1, nodes: [node("approval", "approval")], edges: [] },
  ] satisfies WorkflowGraphDefinition[]) {
    const result = validateWorkflowGraph(graph);

    assert.ok(result.errors.some((error) => error.code === "workflow_graph_requires_employee_task"));
  }
});

test("requires exactly one workflow entry and terminal node", () => {
  const multipleEntries: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      node("A", "employee_task", "employee-a"),
      node("B", "employee_task", "employee-b"),
      node("C", "employee_task", "employee-c"),
    ],
    edges: [
      { source: "A", target: "C" },
      { source: "B", target: "C" },
    ],
  };
  const multipleTerminals: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [
      node("A", "employee_task", "employee-a"),
      node("B", "employee_task", "employee-b"),
      node("C", "employee_task", "employee-c"),
    ],
    edges: [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
    ],
  };

  assert.ok(
    validateWorkflowGraph(multipleEntries).errors.some(
      (error) => error.code === "workflow_graph_requires_single_entry_node",
    ),
  );
  const result = validateWorkflowGraph(multipleTerminals);
  assert.ok(result.errors.some((error) => error.code === "workflow_graph_requires_single_terminal_node"));
  assert.deepEqual(
    result.errors.find((error) => error.code === "workflow_graph_requires_single_terminal_node")?.nodeIds,
    ["B", "C"],
  );
});

test("requires employee task IDs to be non-empty after trimming", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [node("start", "approval"), node("employee", "employee_task", "  ")],
    edges: [{ source: "start", target: "employee" }],
  };

  const result = validateWorkflowGraph(graph);

  assert.ok(result.errors.some((error) => error.code === "workflow_employee_task_requires_employee_id"));
});

test("accepts a single employee task as both entry and terminal", () => {
  const result = validateWorkflowGraph({
    schemaVersion: 1,
    nodes: [node("solo", "employee_task", "employee-solo")],
    edges: [],
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.topologicalOrder, ["solo"]);
});

test("reports non-string employee task IDs without throwing", () => {
  const graph: WorkflowGraphDefinition = {
    schemaVersion: 1,
    nodes: [node("employee", "employee_task", 42 as unknown as string)],
    edges: [],
  };

  const result = validateWorkflowGraph(graph);

  assert.ok(result.errors.some((error) => error.code === "workflow_employee_task_requires_employee_id"));
});

test("rejects node types outside the first-release allowlist", () => {
  const result = validateWorkflowGraph({
    schemaVersion: 1,
    nodes: [{ id: "script", type: "script" as never, config: {} }],
    edges: [],
  });
  assert.ok(result.errors.some((error) => error.code === "workflow_node_type_unsupported"));
});
