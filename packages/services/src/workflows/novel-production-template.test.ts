import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph } from "@dofe-agent/domain";
import { buildNovelProductionWorkflowGraph } from "./novel-production-template.ts";

test("novel-production template is a valid acyclic two-round DAG", () => {
  const graph = buildNovelProductionWorkflowGraph({ coordinatorEmployeeId: "emp-coord" });
  const result = validateWorkflowGraph(graph);
  assert.deepEqual(result.errors, []);
  assert.equal(result.topologicalOrder.length, graph.nodes.length);
});

test("novel-production template fans out parallel art/script per round and converges", () => {
  const graph = buildNovelProductionWorkflowGraph({
    coordinatorEmployeeId: "emp-coord",
    artistEmployeeId: "emp-artist",
    scriptEmployeeId: "emp-script",
  });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("art-r1")?.employeeId, "emp-artist");
  assert.equal(byId.get("script-r1")?.employeeId, "emp-script");
  assert.equal(graph.edges.filter((edge) => edge.target === "round1-join").length, 2);
  assert.equal(graph.edges.filter((edge) => edge.target === "round2-join").length, 2);
});
