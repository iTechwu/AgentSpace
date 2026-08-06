import assert from "node:assert/strict";
import test from "node:test";
import {
  collectWorkflowDescendantNodeIds,
  completeWorkflowNodeSync,
  decideWorkflowDownstreamTransition,
  resolveWorkflowRunTerminalStatus,
} from "./coordinator.ts";

test("failed joins identify every downstream node that must be skipped", () => {
  assert.deepEqual(collectWorkflowDescendantNodeIds({
    schemaVersion: 1,
    nodes: [
      { id: "join", type: "join", config: {} },
      { id: "summary", type: "employee_task", employeeId: "employee-1", config: {} },
      { id: "notify", type: "employee_task", employeeId: "employee-2", config: {} },
    ],
    edges: [{ source: "join", target: "summary" }, { source: "summary", target: "notify" }],
  }, "join"), ["summary", "notify"]);
});

test("downstream waits until every predecessor reaches a terminal state", () => {
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "employee_task",
    policy: "all_success",
    predecessorStatuses: ["succeeded", "running"],
  }), "wait");
});

test("ordinary downstream becomes ready only when every predecessor succeeds", () => {
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "employee_task",
    policy: "all_success",
    predecessorStatuses: ["succeeded", "succeeded"],
  }), "ready");
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "employee_task",
    policy: "all_success",
    predecessorStatuses: ["succeeded", "failed"],
  }), "fail");
});

test("all-success join fails when any predecessor does not succeed", () => {
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "join",
    policy: "all_success",
    predecessorStatuses: ["succeeded", "failed"],
  }), "fail");
});

test("partial join succeeds with one result and fails when all branches fail", () => {
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "join",
    policy: "allow_partial",
    predecessorStatuses: ["succeeded", "failed"],
  }), "succeed_join");
  assert.equal(decideWorkflowDownstreamTransition({
    nodeType: "join",
    policy: "allow_partial",
    predecessorStatuses: ["failed", "skipped"],
  }), "fail");
});

test("only an explicit successful partial join produces a partially-succeeded run", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [
      { id: "a", type: "employee_task" as const, employeeId: "employee-a", config: {} },
      { id: "b", type: "employee_task" as const, employeeId: "employee-b", config: {} },
      { id: "join", type: "join" as const, config: { policy: "allow_partial" } },
      { id: "summary", type: "employee_task" as const, employeeId: "employee-summary", config: {} },
    ],
    edges: [
      { source: "a", target: "join" },
      { source: "b", target: "join" },
      { source: "join", target: "summary" },
    ],
  };
  assert.equal(resolveWorkflowRunTerminalStatus([
    { nodeId: "a", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
    { nodeId: "b", nodeType: "employee_task", status: "failed", inputJson: "{}" },
    { nodeId: "join", nodeType: "join", status: "succeeded", inputJson: JSON.stringify({ policy: "allow_partial" }) },
    { nodeId: "summary", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
  ], graph), "partially_succeeded");
  assert.equal(resolveWorkflowRunTerminalStatus([
    { nodeId: "a", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
    { nodeId: "b", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
    { nodeId: "join", nodeType: "join", status: "succeeded", inputJson: JSON.stringify({ policy: "allow_partial" }) },
    { nodeId: "summary", nodeType: "employee_task", status: "failed", inputJson: "{}" },
  ], graph), "failed");
  assert.equal(resolveWorkflowRunTerminalStatus([
    { nodeId: "a", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
    { nodeId: "b", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
    { nodeId: "join", nodeType: "join", status: "succeeded", inputJson: JSON.stringify({ policy: "allow_partial" }) },
    { nodeId: "summary", nodeType: "employee_task", status: "succeeded", inputJson: "{}" },
  ], graph), "succeeded");
});

test("completion rejects an unknown node run before changing any state", () => {
  assert.throws(
    () => completeWorkflowNodeSync({ workspaceId: "missing-workspace", nodeRunId: "missing-node", taskQueueId: "missing-task", output: {} }),
    /workflow_node_run_not_found|PostgreSQL database URL is required/,
  );
});
