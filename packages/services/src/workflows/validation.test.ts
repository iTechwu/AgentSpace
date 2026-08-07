import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  canonicalizeWorkflowGraph,
  hashWorkflowGraph,
  validateWorkflowEmployeeReadiness,
  validateWorkflowGovernance,
  validateWorkflowNodeDependencies,
  validateWorkflowForPublishSync,
  workflowNodeAttributedCost,
  workflowNodeMaxAttempts,
} from "./validation.ts";

test("governance requires a bounded integer concurrency limit", () => {
  assert.deepEqual(validateWorkflowGovernance({ maxConcurrency: 8 }), []);
  assert.equal(validateWorkflowGovernance({ maxConcurrency: 0 })[0]?.code, "workflow_concurrency_invalid");
  assert.equal(validateWorkflowGovernance({ maxConcurrency: 2.5 })[0]?.code, "workflow_concurrency_invalid");
});

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
    memberUserIds: new Set<string>(),
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
    memberUserIds: new Set<string>(),
  });

  assert.deepEqual(blockers, []);
});

test("attributed cost multiplies the per-run estimate by the retry attempt count", () => {
  const node = (maxAttempts: unknown, estimate?: number) => ({
    id: "research",
    type: "employee_task" as const,
    employeeId: "emp-1",
    config: { estimatedCostUsd: estimate, retry: { maxAttempts } },
  });
  assert.equal(workflowNodeMaxAttempts(node(3)), 3);
  assert.equal(workflowNodeMaxAttempts(node(undefined)), 1);
  assert.equal(workflowNodeMaxAttempts(node(1.5)), 1);
  assert.equal(workflowNodeAttributedCost(node(3, 6)), 18);
  assert.equal(workflowNodeAttributedCost(node(1, 6)), 6);
  assert.equal(workflowNodeAttributedCost(node(3, undefined)), undefined);
});

test("node budget preflight accounts for retry-attributed cost", () => {
  const inventory = {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map<string, { employeeNames: string[] }>(),
    memberUserIds: new Set<string>(),
  };
  // estimate 3 × maxAttempts 2 = 6 > node budget 5 → blocked
  const blocked = validateWorkflowNodeDependencies({
    id: "research",
    type: "employee_task",
    employeeId: "emp-1",
    config: { estimatedCostUsd: 3, budgetUsd: 5, retry: { maxAttempts: 2 } },
  }, inventory);
  assert.equal(blocked[0]?.code, "workflow_budget_exceeded");
  assert.ok(blocked[0]?.detail.startsWith("attributed_cost_6_exceeds_node_budget_5"));

  // estimate 3 × maxAttempts 1 = 3 ≤ node budget 5 → passes
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "research",
    type: "employee_task",
    employeeId: "emp-1",
    config: { estimatedCostUsd: 3, budgetUsd: 5 },
  }, inventory), []);
});

test("dependency preflight rejects retry limits outside the supported range", () => {
  const inventory = {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map<string, { employeeNames: string[] }>(),
    memberUserIds: new Set<string>(),
  };
  for (const maxAttempts of [0, 1.5, 11, 1_000_000_000]) {
    const blockers = validateWorkflowNodeDependencies({
      id: "research",
      type: "employee_task",
      employeeId: "emp-1",
      config: { retry: { maxAttempts } },
    }, inventory);
    assert.equal(blockers[0]?.code, "workflow_retry_policy_invalid");
  }
});

test("dependency preflight keeps an empty retry object on the default single attempt", () => {
  const blockers = validateWorkflowNodeDependencies({
    id: "research",
    type: "employee_task",
    employeeId: "emp-1",
    config: { retry: {} },
  }, {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map<string, { employeeNames: string[] }>(),
    memberUserIds: new Set<string>(),
  });
  assert.deepEqual(blockers, []);
});

test("approval preflight requires a known employee and a joined channel", () => {
  const inventory = {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher", remarkName: "研究员" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map([["项目审批群", { employeeNames: ["研究员"] }]]),
    memberUserIds: new Set(["user-1", "user-2"]),
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

test("approval preflight validates risk enum and designated reviewer membership", () => {
  const inventory = {
    employees: new Map([["emp-1", { id: "emp-1", name: "Researcher", remarkName: "研究员" }]]),
    assignedSkills: new Set<string>(),
    channels: new Map([["项目审批群", { employeeNames: ["研究员"] }]]),
    memberUserIds: new Set(["user-1"]),
  };
  const base = { employeeId: "emp-1", channelName: "项目审批群" };
  // 非法风险等级。
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval", type: "approval", config: { ...base, risk: "critical" },
  }, inventory).map((blocker) => blocker.code), ["workflow_approval_risk_invalid"]);
  // 指定审批人不在工作区成员中。
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval", type: "approval", config: { ...base, reviewerUserId: "outsider" },
  }, inventory).map((blocker) => blocker.code), ["workflow_approval_reviewer_not_ready"]);
  // 合法风险 + 合法审批人通过。
  assert.deepEqual(validateWorkflowNodeDependencies({
    id: "approval", type: "approval", config: { ...base, risk: "high", reviewerUserId: "user-1" },
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
