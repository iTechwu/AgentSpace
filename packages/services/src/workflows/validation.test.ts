import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  canonicalizeWorkflowGraph,
  hashWorkflowGraph,
  validateWorkflowEmployeeReadiness,
  validateWorkflowNodeDependencies,
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
  assert.equal(canonicalizeJson({ "ä": 1, z: 2 }), '{"z":2,"ä":1}');
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

test("dependency preflight blocks missing skills, channel membership, and invalid budgets", () => {
  const node = {
    id: "research",
    type: "employee_task" as const,
    employeeId: "emp-1",
    config: {
      requiredSkillIds: ["web-search", "analysis"],
      channelName: "项目协作群",
      budgetUsd: 1,
      estimatedCostUsd: 2,
    },
  };
  const blockers = validateWorkflowNodeDependencies(node, {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher", remarkName: "研究员" }]]),
    assignedSkills: new Set(["emp-1\u0000analysis"]),
    channels: new Map([["项目协作群", { employeeNames: ["其他员工"] }]]),
  });

  assert.deepEqual(blockers.map((blocker) => blocker.code), [
    "workflow_skill_not_ready",
    "workflow_channel_not_ready",
    "workflow_budget_exceeded",
  ]);
});

test("dependency preflight accepts assigned skills and employee display names", () => {
  const blockers = validateWorkflowNodeDependencies({
    id: "research",
    type: "employee_task",
    employeeId: "emp-1",
    config: { requiredSkillIds: ["analysis"], channelName: "项目协作群", budgetUsd: 3, estimatedCostUsd: 2 },
  }, {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher", remarkName: "研究员" }]]),
    assignedSkills: new Set(["emp-1\u0000analysis"]),
    channels: new Map([["项目协作群", { employeeNames: ["研究员"] }]]),
  });

  assert.deepEqual(blockers, []);
});

test("approval preflight requires a known employee and a joined channel", () => {
  const inventory = {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher", remarkName: "研究员" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map([["项目审批群", { employeeNames: ["研究员"] }]]),
  };
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval",
    type: "approval",
    config: { employeeId: "missing", channelName: "项目审批群" },
  }, inventory).map((blocker) => blocker.code), ["workflow_approval_employee_not_ready"]);
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval",
    type: "approval",
    config: { employeeId: "emp-1", channelName: "missing" },
  }, inventory).map((blocker) => blocker.code), ["workflow_approval_channel_not_ready"]);
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval",
    type: "approval",
    config: { employeeId: "emp-1", channelName: "项目审批群" },
  }, inventory), []);
});

test("dispatch readiness detects deleted and offline employees", () => {
  const node = { id: "research", type: "employee_task" as const, employeeId: "emp-1", config: {} };
  assert.equal(validateWorkflowEmployeeReadiness(node, new Map(), new Map())?.detail, "employee_not_found");
  assert.equal(validateWorkflowEmployeeReadiness(
    node,
    new Map([["emp-1", { id: "emp-1" }]]),
    new Map([["emp-1", { status: "offline" }]]),
  )?.detail, "runtime_binding_offline");
  assert.equal(validateWorkflowEmployeeReadiness(
    node,
    new Map([["emp-1", { id: "emp-1" }]]),
    new Map([["emp-1", { status: "online" }]]),
  ), undefined);
});
