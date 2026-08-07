import { validateWorkflowGraph, type WorkflowGraphDefinition } from "@dofe-agent/domain";

export interface WorkflowDraftValidationError {
  code: string;
  nodeId?: string;
  field?: "employeeId" | "connection" | "node";
}

export interface WorkflowDraftValidationResult {
  errors: WorkflowDraftValidationError[];
  topologicalOrder: string[];
}

export function validateWorkflowDraft(graph: WorkflowGraphDefinition): WorkflowDraftValidationResult {
  const result = validateWorkflowGraph(graph);
  const errors = result.errors
    // A terminal Join is allowed while composing; publish preflight still requires its downstream node.
    .filter((error) => error.code !== "workflow_join_requires_downstream")
    .flatMap((error): WorkflowDraftValidationError[] => {
      const field = error.code === "workflow_employee_task_requires_employee_id"
        ? "employeeId" as const
        : error.code.includes("edge") || error.code.includes("cycle") || error.code.includes("join")
          ? "connection" as const
          : "node" as const;
      if (error.nodeIds.length === 0) return [{ code: error.code, field }];
      return error.nodeIds.map((nodeId) => ({ code: error.code, nodeId, field }));
    });
  return { errors, topologicalOrder: result.topologicalOrder };
}
