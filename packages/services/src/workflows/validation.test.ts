import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  canonicalizeWorkflowGraph,
  hashWorkflowGraph,
  validateWorkflowForPublishSync,
} from "./validation.ts";

const validGraph = {
  schemaVersion: 1 as const,
  nodes: [{ id: "start", type: "employee_task" as const, employeeId: "emp-1", config: { z: 1, a: 2 } }],
  edges: [],
};

test("canonical workflow JSON sorts object keys but preserves node and edge order", () => {
  const left = { ...validGraph, nodes: [{ ...validGraph.nodes[0]!, config: { a: 2, z: 1 } }] };
  assert.equal(canonicalizeWorkflowGraph(left), canonicalizeWorkflowGraph(validGraph));
  assert.equal(hashWorkflowGraph(left), hashWorkflowGraph(validGraph));
  assert.equal(canonicalizeJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
});

test("graph blockers are returned before readiness queries", () => {
  const result = validateWorkflowForPublishSync({
    workspaceId: "missing-workspace",
    graph: {
      schemaVersion: 1,
      nodes: [{ id: "approval", type: "approval", config: {} }],
      edges: [],
    },
    actor: { userId: "viewer", role: "viewer" },
  });

  assert.ok(result.blockers.some((blocker) => blocker.code === "workflow_actor_forbidden"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "workflow_graph_requires_employee_task"));
});
