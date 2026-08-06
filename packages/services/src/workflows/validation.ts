import { createHash } from "node:crypto";
import {
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
  actor: { userId: string; displayName?: string; role: WorkflowActorRole };
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

  const employees = new Map(listStoredEmployeesSync(input.workspaceId).map((employee) => [employee.id, employee]));
  const bindings = new Map(
    listEmployeeRuntimeBindingsSync(input.workspaceId).map((binding) => [binding.employeeId, binding]),
  );
  for (const node of input.graph.nodes) {
    if (node.type !== "employee_task") continue;
    const blocker = employeeReadinessBlocker(node, employees, bindings);
    if (blocker) blockers.push(blocker);
  }
  return { blockers, warnings };
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
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
