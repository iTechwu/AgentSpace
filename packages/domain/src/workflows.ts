export type WorkflowNodeType = "employee_task" | "join" | "approval";
export type WorkflowJoinPolicy = "all_success" | "allow_partial";
export const WORKFLOW_NODE_TYPES = ["employee_task", "join", "approval"] as const satisfies readonly WorkflowNodeType[];
export const WORKFLOW_EVENT_NAMES = [
  "task.completed",
  "document.updated",
  "message.matched",
] as const;
export type WorkflowEventName = typeof WORKFLOW_EVENT_NAMES[number];

export function isWorkflowEventName(value: string): value is WorkflowEventName {
  return (WORKFLOW_EVENT_NAMES as readonly string[]).includes(value);
}

export function isWorkflowNodeType(value: string): value is WorkflowNodeType {
  return (WORKFLOW_NODE_TYPES as readonly string[]).includes(value);
}

export type WorkflowDefinitionStatus = "draft" | "published" | "paused" | "archived";
export type WorkflowRunStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "cancelled";
export type WorkflowNodeRunStatus =
  | "pending"
  | "ready"
  | "queued"
  | "running"
  | "waiting_approval"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  employeeId?: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdgeDefinition {
  source: string;
  target: string;
}

export interface WorkflowGraphDefinition {
  schemaVersion: 1;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export interface WorkflowGraphError {
  code: string;
  nodeIds: string[];
}

export interface WorkflowGraphValidationResult {
  errors: WorkflowGraphError[];
  topologicalOrder: string[];
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

/** Validates graph structure and returns every detected error without throwing. */
export function validateWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphValidationResult {
  const errors: WorkflowGraphError[] = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeIds = nodes.map((node) => node?.id).filter((id): id is string => typeof id === "string");
  const nodeIdSet = new Set(nodeIds);
  const nodeIndex = new Map<string, number>();

  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node.id !== "string") continue;
    if (nodeIndex.has(node.id)) {
      errors.push({ code: "workflow_graph_duplicate_node_id", nodeIds: [node.id] });
    } else {
      nodeIndex.set(node.id, index);
    }
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIndex.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
    indegree.set(id, 0);
  }

  for (const edge of edges) {
    const source = edge?.source;
    const target = edge?.target;
    const sourceExists = typeof source === "string" && nodeIdSet.has(source);
    const targetExists = typeof target === "string" && nodeIdSet.has(target);
    if (!sourceExists || !targetExists) {
      errors.push({
        code: "workflow_graph_edge_endpoint_missing",
        nodeIds: uniqueInOrder([
          ...(typeof source === "string" ? [source] : []),
          ...(typeof target === "string" ? [target] : []),
        ]),
      });
      continue;
    }
    outgoing.get(source)?.push(target);
    incoming.get(target)?.push(source);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !nodeIndex.has(node.id)) continue;
    const nodeType = typeof (node as { type?: unknown }).type === "string"
      ? (node as { type: string }).type
      : "";
    if (!isWorkflowNodeType(nodeType)) {
      errors.push({ code: "workflow_node_type_unsupported", nodeIds: [node.id] });
      continue;
    }
    if (
      node.type === "employee_task" &&
      (typeof node.employeeId !== "string" || node.employeeId.trim().length === 0)
    ) {
      errors.push({ code: "workflow_employee_task_requires_employee_id", nodeIds: [node.id] });
    }
    if (node.type === "join" && new Set(incoming.get(node.id) ?? []).size < 2) {
      errors.push({ code: "workflow_join_requires_multiple_inputs", nodeIds: [node.id] });
    }
    if (node.type === "join" && (outgoing.get(node.id) ?? []).length === 0) {
      errors.push({ code: "workflow_join_requires_downstream", nodeIds: [node.id] });
    }
  }

  const roots = [...nodeIndex.keys()].filter((id) => (incoming.get(id) ?? []).length === 0);
  const terminals = [...nodeIndex.keys()].filter((id) => (outgoing.get(id) ?? []).length === 0);
  if (!nodes.some((node) => node?.type === "employee_task")) {
    errors.push({ code: "workflow_graph_requires_employee_task", nodeIds: [...nodeIndex.keys()] });
  }
  if (roots.length !== 1) {
    errors.push({ code: "workflow_graph_requires_single_entry_node", nodeIds: roots });
  }
  if (terminals.length !== 1) {
    errors.push({ code: "workflow_graph_requires_single_terminal_node", nodeIds: terminals });
  }

  const reachable = new Set<string>();
  const pending = roots.length > 0 ? [roots[0]!] : [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  for (const id of nodeIndex.keys()) {
    const hasIncoming = (incoming.get(id) ?? []).length > 0;
    const hasOutgoing = (outgoing.get(id) ?? []).length > 0;
    if (!reachable.has(id)) {
      errors.push({
        code: hasIncoming || hasOutgoing ? "workflow_node_unreachable" : "workflow_graph_isolated_node",
        nodeIds: [id],
      });
    } else if (nodeIndex.size > 1 && !hasIncoming && !hasOutgoing) {
      errors.push({ code: "workflow_graph_isolated_node", nodeIds: [id] });
    }
  }

  const remainingIndegree = new Map(indegree);
  const ready = [...nodeIndex.keys()].filter((id) => remainingIndegree.get(id) === 0);
  const topologicalOrder: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (nodeIndex.get(left) ?? 0) - (nodeIndex.get(right) ?? 0));
    const current = ready.shift();
    if (!current) continue;
    topologicalOrder.push(current);
    for (const target of outgoing.get(current) ?? []) {
      const nextDegree = (remainingIndegree.get(target) ?? 0) - 1;
      remainingIndegree.set(target, nextDegree);
      if (nextDegree === 0) ready.push(target);
    }
  }
  if (topologicalOrder.length < nodeIndex.size) {
    const cycleNodes = [...nodeIndex.keys()].filter((id) => !topologicalOrder.includes(id));
    errors.push({ code: "workflow_graph_cycle", nodeIds: cycleNodes });
  }

  return { errors, topologicalOrder };
}
