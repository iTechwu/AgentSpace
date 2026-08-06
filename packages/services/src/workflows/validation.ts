import { createHash } from "node:crypto";
import {
  listStoredAgentSkillAssignmentsSync,
  listStoredChannelsSync,
  listStoredEmployeesSync,
  listEmployeeRuntimeBindingsSync,
} from "@dofe-agent/db";
import {
  validateWorkflowGraph,
  type WorkflowGraphDefinition,
  type WorkflowNodeDefinition,
} from "@dofe-agent/domain";

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
}

export interface WorkflowDependencyInventory {
  employees: Map<string, { id: string; name: string; remarkName?: string }>;
  assignedSkills: Set<string>;
  channels: Map<string, { employeeNames: string[] }>;
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

export function validateWorkflowForPublishSync(
  input: ValidateWorkflowForPublishInput,
): WorkflowPublishValidation {
  const blockers: WorkflowPublishBlocker[] = [];
  const warnings: WorkflowPublishBlocker[] = [];
  if (input.actor.role === "viewer") {
    blockers.push({ code: "workflow_actor_forbidden", detail: "viewer cannot publish workflows" });
  }

  const graphResult = validateWorkflowGraph(input.graph);
  for (const error of graphResult.errors) {
    for (const nodeId of error.nodeIds.length > 0 ? error.nodeIds : [undefined]) {
      blockers.push({ code: error.code, nodeId });
    }
  }
  if (graphResult.errors.length > 0) return { blockers, warnings };

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
  };
  const workflowBudget = optionalFiniteNumber(input.governance?.budgetUsd);
  if (input.governance?.budgetUsd !== undefined && workflowBudget === undefined) {
    blockers.push({ code: "workflow_budget_invalid", detail: "workflow_budget_must_be_positive" });
  }
  for (const node of input.graph.nodes) {
    if (node.type !== "employee_task") continue;
    const blocker = employeeReadinessBlocker(node, employees, bindings);
    if (blocker) {
      blockers.push(blocker);
      continue;
    }
    blockers.push(...validateWorkflowNodeDependencies(node, inventory));
    if (workflowBudget !== undefined) {
      const estimate = optionalFiniteNumber(node.config.estimatedCostUsd);
      if (estimate !== undefined && estimate > workflowBudget) {
        blockers.push({
          code: "workflow_budget_exceeded",
          nodeId: node.id,
          employeeId: node.employeeId,
          detail: `estimated_cost_${estimate}_exceeds_workflow_budget_${workflowBudget}`,
        });
      }
    }
  }
  return { blockers, warnings };
}

export function validateWorkflowNodeDependencies(
  node: WorkflowNodeDefinition,
  inventory: WorkflowDependencyInventory,
): WorkflowPublishBlocker[] {
  if (node.type !== "employee_task" || !node.employeeId) return [];
  const blockers: WorkflowPublishBlocker[] = [];
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
      const estimate = optionalFiniteNumber(node.config.estimatedCostUsd);
      if (estimate !== undefined && estimate > budget) {
        blockers.push({
          code: "workflow_budget_exceeded",
          nodeId: node.id,
          employeeId: node.employeeId,
          detail: `estimated_cost_${estimate}_exceeds_node_budget_${budget}`,
        });
      }
    }
  }
  return blockers;
}

function employeeReadinessBlocker(
  node: WorkflowNodeDefinition,
  employees: Map<string, { id: string }>,
  bindings: Map<string, { status: string }>,
): WorkflowPublishBlocker | undefined {
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
