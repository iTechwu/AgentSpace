import { createHash } from "node:crypto";
import {
  listStoredAgentSkillAssignmentsSync,
  listStoredChannelsSync,
  listStoredEmployeesSync,
  listEmployeeRuntimeBindingsSync,
  listWorkspaceMemberUsersSync,
} from "@dofe-agent/db";
import {
  validateWorkflowGraph,
  type WorkflowGraphDefinition,
  type WorkflowNodeDefinition,
} from "@dofe-agent/domain";
import { validateWorkflowInputReferences } from "./inputs.ts";
import { normalizeWorkflowTriggerForPublish } from "./scheduler.ts";

export type WorkflowActorRole = "owner" | "admin" | "editor" | "viewer";

export interface WorkflowPublishBlocker {
  code: string;
  nodeId?: string;
  employeeId?: string;
  detail?: string;
}

export interface WorkflowPublishValidation {
  blockers: WorkflowPublishBlocker[];
  warnings: WorkflowPublishBlocker[];
}

export interface ValidateWorkflowForPublishInput {
  workspaceId: string;
  graph: WorkflowGraphDefinition;
  governance?: Record<string, unknown>;
  actor: { userId: string; displayName?: string; role: WorkflowActorRole };
  trigger?: {
    type: "manual" | "schedule" | "event";
    configJson: string;
    timezone?: string;
    nextFireAt?: string;
    misfirePolicy?: "skip" | "fire_once";
  };
}

export interface WorkflowDependencyInventory {
  employees: Map<string, { id: string; name: string; remarkName?: string }>;
  assignedSkills: Set<string>;
  channels: Map<string, { employeeNames: string[] }>;
  memberUserIds: Set<string>;
}

export interface WorkflowRuntimeBindingInventory {
  status: string;
}

export function canonicalizeWorkflowGraph(graph: WorkflowGraphDefinition): string {
  return stableStringify(graph);
}

export function canonicalizeJson(value: unknown): string {
  return stableStringify(value);
}

export function hashWorkflowGraph(graph: WorkflowGraphDefinition): string {
  return `sha256:${createHash("sha256").update(canonicalizeWorkflowGraph(graph), "utf8").digest("hex")}`;
}

export function hashWorkflowVersionContent(input: {
  graph: WorkflowGraphDefinition;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  governance?: Record<string, unknown>;
}): string {
  const content = canonicalizeJson({
    graph: input.graph,
    governance: input.governance ?? {},
    inputSchema: input.inputSchema ?? {},
    outputSchema: input.outputSchema ?? {},
  });
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function validateWorkflowForPublishSync(
  input: ValidateWorkflowForPublishInput,
): WorkflowPublishValidation {
  const blockers: WorkflowPublishBlocker[] = [];
  const warnings: WorkflowPublishBlocker[] = [];
  if (input.actor.role === "viewer") {
    blockers.push({ code: "workflow_actor_forbidden", detail: "viewer cannot publish workflows" });
  }
  blockers.push(...validateWorkflowGovernance(input.governance));
  if (input.trigger) {
    try {
      normalizeWorkflowTriggerForPublish(input.trigger);
    } catch (error) {
      const code = error instanceof Error ? error.message : "workflow_schedule_invalid";
      blockers.push({ code });
    }
  }

  const graphResult = validateWorkflowGraph(input.graph);
  for (const error of graphResult.errors) {
    for (const nodeId of error.nodeIds.length > 0 ? error.nodeIds : [undefined]) {
      blockers.push({ code: error.code, nodeId });
    }
  }
  if (graphResult.errors.length > 0) return { blockers, warnings };
  blockers.push(...validateWorkflowInputReferences(input.graph));
  if (blockers.length > 0) return { blockers, warnings };

  const employees = new Map(
    listStoredEmployeesSync(input.workspaceId).map((employee) => [employee.id, employee]),
  );
  const bindings = new Map(
    listEmployeeRuntimeBindingsSync(input.workspaceId).map((binding) => [binding.employeeId, binding]),
  );
  const inventory: WorkflowDependencyInventory = {
    employees,
    assignedSkills: new Set(
      listStoredAgentSkillAssignmentsSync(input.workspaceId)
        .map((assignment) => dependencyKey(assignment.employeeId, assignment.skillId)),
    ),
    channels: new Map(
      listStoredChannelsSync(input.workspaceId).map((channel) => [channel.name, channel]),
    ),
    memberUserIds: new Set(
      listWorkspaceMemberUsersSync(input.workspaceId).map((member) => member.userId),
    ),
  };
  const workflowBudget = optionalFiniteNumber(input.governance?.budgetUsd);
  if (input.governance?.budgetUsd !== undefined && workflowBudget === undefined) {
    blockers.push({ code: "workflow_budget_invalid", detail: "workflow_budget_must_be_positive" });
  }
  for (const node of input.graph.nodes) {
    if (node.type === "employee_task") {
    const blocker = validateWorkflowEmployeeReadiness(node, employees, bindings);
      if (blocker) {
        blockers.push(blocker);
        continue;
      }
    }
    blockers.push(...validateWorkflowNodeDependencies(node, inventory));
    if (node.type === "employee_task" && workflowBudget !== undefined) {
      const attributed = workflowNodeAttributedCost(node);
      if (attributed !== undefined && attributed > workflowBudget) {
        blockers.push({
          code: "workflow_budget_exceeded",
          nodeId: node.id,
          employeeId: node.employeeId,
          detail: `attributed_cost_${attributed}_exceeds_workflow_budget_${workflowBudget}`,
        });
      }
    }
  }
  if (workflowBudget !== undefined) {
    const attributedTotal = input.graph.nodes.reduce((total, node) => (
      total + (workflowNodeAttributedCost(node) ?? 0)
    ), 0);
    if (attributedTotal > workflowBudget) {
      blockers.push({
        code: "workflow_budget_exceeded",
        detail: `attributed_total_${attributedTotal}_exceeds_workflow_budget_${workflowBudget}`,
      });
    }
  }
  return { blockers, warnings };
}

export function validateWorkflowGovernance(governance?: Record<string, unknown>): WorkflowPublishBlocker[] {
  if (governance?.maxConcurrency === undefined) return [];
  const value = governance.maxConcurrency;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20
    ? []
    : [{ code: "workflow_concurrency_invalid", detail: "max_concurrency_must_be_integer_1_to_20" }];
}

export function validateWorkflowNodeForDispatchSync(
  workspaceId: string,
  node: WorkflowNodeDefinition,
): WorkflowPublishBlocker | undefined {
  const employees = new Map(
    listStoredEmployeesSync(workspaceId).map((employee) => [employee.id, employee]),
  );
  const bindings = new Map(
    listEmployeeRuntimeBindingsSync(workspaceId).map((binding) => [binding.employeeId, binding]),
  );
  const readiness = validateWorkflowEmployeeReadiness(node, employees, bindings);
  if (readiness) return readiness;
  return validateWorkflowNodeDependencies(node, {
    employees,
    assignedSkills: new Set(
      listStoredAgentSkillAssignmentsSync(workspaceId)
        .map((assignment) => dependencyKey(assignment.employeeId, assignment.skillId)),
    ),
    channels: new Map(
      listStoredChannelsSync(workspaceId).map((channel) => [channel.name, channel]),
    ),
    memberUserIds: new Set(
      listWorkspaceMemberUsersSync(workspaceId).map((member) => member.userId),
    ),
  })[0];
}

export function validateWorkflowNodeDependencies(
  node: WorkflowNodeDefinition,
  inventory: WorkflowDependencyInventory,
): WorkflowPublishBlocker[] {
  if (node.type === "approval") return validateApprovalDependencies(node, inventory);
  if (node.type !== "employee_task" || !node.employeeId) return [];
  const blockers: WorkflowPublishBlocker[] = [];
  if (node.config.retry !== undefined) {
    const retry = node.config.retry;
    const retryRecord = retry && typeof retry === "object" && !Array.isArray(retry)
      ? retry as Record<string, unknown>
      : undefined;
    const maxAttempts = retryRecord?.maxAttempts;
    if (!retryRecord || (maxAttempts !== undefined && (
      typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
    ))) {
      blockers.push({
        code: "workflow_retry_policy_invalid",
        nodeId: node.id,
        employeeId: node.employeeId,
        detail: "max_attempts_must_be_integer_1_to_10",
      });
    }
  }
  const requiredSkillIds = Array.isArray(node.config.requiredSkillIds)
    ? node.config.requiredSkillIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  for (const skillId of requiredSkillIds) {
    if (!inventory.assignedSkills.has(dependencyKey(node.employeeId, skillId))) {
      blockers.push({
        code: "workflow_skill_not_ready",
        nodeId: node.id,
        employeeId: node.employeeId,
        detail: skillId,
      });
    }
  }

  const channelName = typeof node.config.channelName === "string" ? node.config.channelName.trim() : "";
  if (channelName) {
    const employee = inventory.employees.get(node.employeeId);
    const channel = inventory.channels.get(channelName);
    const acceptedNames = new Set([employee?.name, employee?.remarkName].filter((value): value is string => Boolean(value)));
    if (!channel || !channel.employeeNames.some((name) => acceptedNames.has(name))) {
      blockers.push({
        code: "workflow_channel_not_ready",
        nodeId: node.id,
        employeeId: node.employeeId,
        detail: channelName,
      });
    }
  }

  if (node.config.budgetUsd !== undefined) {
    const budget = optionalFiniteNumber(node.config.budgetUsd);
    if (budget === undefined) {
      blockers.push({
        code: "workflow_budget_invalid",
        nodeId: node.id,
        employeeId: node.employeeId,
        detail: "node_budget_must_be_positive",
      });
    } else {
      const attributed = workflowNodeAttributedCost(node);
      if (attributed !== undefined && attributed > budget) {
        blockers.push({
          code: "workflow_budget_exceeded",
          nodeId: node.id,
          employeeId: node.employeeId,
          detail: `attributed_cost_${attributed}_exceeds_node_budget_${budget}`,
        });
      }
    }
  }
  return blockers;
}

function validateApprovalDependencies(
  node: WorkflowNodeDefinition,
  inventory: WorkflowDependencyInventory,
): WorkflowPublishBlocker[] {
  const blockers: WorkflowPublishBlocker[] = [];
  const employeeId = typeof node.config.employeeId === "string" ? node.config.employeeId.trim() : "";
  const employee = inventory.employees.get(employeeId);
  if (!employee) {
    blockers.push({ code: "workflow_approval_employee_not_ready", nodeId: node.id, employeeId, detail: "employee_not_found" });
    return blockers;
  }
  const channelName = typeof node.config.channelName === "string" ? node.config.channelName.trim() : "";
  const channel = inventory.channels.get(channelName);
  const acceptedNames = new Set([employee.name, employee.remarkName].filter((value): value is string => Boolean(value)));
  if (!channel || !channel.employeeNames.some((name) => acceptedNames.has(name))) {
    blockers.push({ code: "workflow_approval_channel_not_ready", nodeId: node.id, employeeId, detail: channelName || "channel_missing" });
    return blockers;
  }
  // 风险等级：可选，但指定时必须是 low/medium/high 之一。
  if (node.config.risk !== undefined) {
    const risk = node.config.risk;
    if (risk !== "low" && risk !== "medium" && risk !== "high") {
      blockers.push({ code: "workflow_approval_risk_invalid", nodeId: node.id, employeeId, detail: "risk_must_be_low_medium_high" });
    }
  }
  // 指定审批人：可选，但指定时必须是当前工作区的活跃成员。
  const reviewerUserId = typeof node.config.reviewerUserId === "string" ? node.config.reviewerUserId.trim() : "";
  if (reviewerUserId) {
    if (!inventory.memberUserIds.has(reviewerUserId)) {
      blockers.push({ code: "workflow_approval_reviewer_not_ready", nodeId: node.id, employeeId, detail: "reviewer_not_workspace_member" });
    }
  }
  return blockers;
}

export function validateWorkflowEmployeeReadiness(
  node: WorkflowNodeDefinition,
  employees: Map<string, { id: string }>,
  bindings: Map<string, WorkflowRuntimeBindingInventory>,
): WorkflowPublishBlocker | undefined {
  if (node.type !== "employee_task") return undefined;
  const employeeId = node.employeeId;
  if (typeof employeeId !== "string" || !employees.has(employeeId)) {
    return { code: "workflow_employee_not_ready", nodeId: node.id, employeeId, detail: "employee_not_found" };
  }
  const binding = bindings.get(employeeId);
  if (!binding || binding.status !== "online") {
    return {
      code: "workflow_employee_not_ready",
      nodeId: node.id,
      employeeId,
      detail: binding ? `runtime_binding_${binding.status}` : "runtime_binding_missing",
    };
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function dependencyKey(employeeId: string, skillId: string): string {
  return `${employeeId}\u0000${skillId}`;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Worst-case attempt count for a node, derived from its retry policy.
 * Invalid/missing retry config collapses to a single attempt; out-of-range
 * values are left for `validateWorkflowNodeDependencies` to flag separately.
 */
export function workflowNodeMaxAttempts(node: WorkflowNodeDefinition): number {
  const retry = node.config.retry;
  const retryRecord = retry && typeof retry === "object" && !Array.isArray(retry)
    ? retry as Record<string, unknown>
    : undefined;
  const maxAttempts = retryRecord?.maxAttempts;
  return typeof maxAttempts === "number" && Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10
    ? maxAttempts
    : 1;
}

/**
 * Publish-time budget cost attributed to a node: per-run estimate multiplied
 * by its max attempt count, so retry policy is accounted for during preflight.
 */
export function workflowNodeAttributedCost(node: WorkflowNodeDefinition): number | undefined {
  const estimate = optionalFiniteNumber(node.config.estimatedCostUsd);
  if (estimate === undefined) return undefined;
  return estimate * workflowNodeMaxAttempts(node);
}
