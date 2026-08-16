import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflowIterationGroups, validateWorkflowGraph } from "@dofe-agent/domain";
import { buildNovelProductionWorkflowGraph } from "./novel-production-template.ts";

test("novel-production template is valid and expresses convergence as a single iteration_group", () => {
  const graph = buildNovelProductionWorkflowGraph({ coordinatorEmployeeId: "emp-coord", approvalChannelName: "approvals" });
  const result = validateWorkflowGraph(graph);
  assert.deepEqual(result.errors, []);

  const convergence = graph.nodes.find((node) => node.id === "convergence");
  assert.equal(convergence?.type, "iteration_group");
  const config = convergence?.config as {
    maxRounds?: number;
    qualityGate?: { nodeId?: string; blockingField?: string; qualityReportField?: string };
    overLimit?: string;
  };
  assert.equal(config.maxRounds, 2);
  assert.equal(config.qualityGate?.nodeId, "consistency");
  assert.equal(config.qualityGate?.blockingField, "blockingCount");
  assert.equal(config.qualityGate?.qualityReportField, "qualityReportDigest");
  assert.equal(config.overLimit, "approval");
  assert.deepEqual((convergence?.config as { overLimitApproval?: unknown }).overLimitApproval, {
    employeeId: "emp-coord",
    channelName: "approvals",
  });
});

test("compileWorkflowIterationGroups unrolls the convergence group into an acyclic DAG with approval", () => {
  const graph = buildNovelProductionWorkflowGraph({
    coordinatorEmployeeId: "emp-coord",
    artistEmployeeId: "emp-artist",
    scriptEmployeeId: "emp-script",
    approvalChannelName: "approvals",
  });
  const compiled = compileWorkflowIterationGroups(graph);
  const result = validateWorkflowGraph(compiled);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));

  const ids = compiled.nodes.map((node) => node.id);
  assert.ok(ids.includes("convergence.art-r1"));
  assert.ok(ids.includes("convergence.script-r1"));
  assert.ok(ids.includes("convergence.art-r2"));
  assert.ok(ids.includes("convergence.script-r2"));
  assert.ok(ids.includes("convergence.over-limit-approval"));

  const artNode = compiled.nodes.find((node) => node.id === "convergence.art-r1");
  assert.equal(artNode?.employeeId, "emp-artist");
});

test("novel-production template rejects a blank approval channel", () => {
  assert.throws(
    () => buildNovelProductionWorkflowGraph({ coordinatorEmployeeId: "emp-coord", approvalChannelName: "  " }),
    /novel_production_approval_channel_required/,
  );
});
