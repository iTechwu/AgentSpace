export type WorkflowNodeType = "employee_task" | "join" | "approval" | "iteration_group";
export type WorkflowJoinPolicy = "all_success" | "allow_partial";
export const WORKFLOW_NODE_TYPES = ["employee_task", "join", "approval", "iteration_group"] as const satisfies readonly WorkflowNodeType[];
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

/**
 * Config of an `iteration_group` node — a bounded, quality-gated loop. Externally
 * it is a single deep module; internally it iterates its `body` until the quality
 * gate passes or `maxRounds` is exhausted (then `overLimit` applies).
 */
export interface WorkflowIterationGroupConfig {
  maxRounds: number;
  body: WorkflowGraphDefinition;
  qualityGate: {
    /** The body node whose output decides pass vs block. */
    nodeId: string;
    /** The output field whose zero value means "all gates pass". */
    blockingField: string;
  };
  overLimit: "approval" | "fail";
  /** Approver config used when overLimit === "approval" (compiled into an approval node). */
  overLimitApproval?: { employeeId: string; channelName?: string };
}

export const WORKFLOW_GRAPH_ERROR_CODES = [
  "workflow_graph_duplicate_node_id",
  "workflow_graph_edge_endpoint_missing",
  "workflow_node_type_unsupported",
  "workflow_employee_task_requires_employee_id",
  "workflow_join_requires_multiple_inputs",
  "workflow_join_requires_downstream",
  "workflow_graph_requires_employee_task",
  "workflow_graph_requires_single_entry_node",
  "workflow_graph_requires_single_terminal_node",
  "workflow_graph_isolated_node",
  "workflow_node_unreachable",
  "workflow_graph_cycle",
  "workflow_iteration_group_invalid",
] as const;
export type WorkflowGraphErrorCode = typeof WORKFLOW_GRAPH_ERROR_CODES[number];

export interface WorkflowGraphError {
  code: WorkflowGraphErrorCode;
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
    if (node.type === "iteration_group") {
      errors.push(...validateWorkflowIterationGroupConfig(node.id, node.config));
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

/** Validates an `iteration_group` node's config (bounded rounds, quality gate, body). */
function validateWorkflowIterationGroupConfig(
  nodeId: string,
  config: Record<string, unknown>,
): WorkflowGraphError[] {
  const errors: WorkflowGraphError[] = [];
  const invalid = () => {
    errors.push({ code: "workflow_iteration_group_invalid", nodeIds: [nodeId] });
  };

  const maxRounds = config.maxRounds;
  if (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
    invalid();
  }

  const overLimit = config.overLimit;
  if (overLimit !== "approval" && overLimit !== "fail") {
    invalid();
  }

  const qualityGate = config.qualityGate as { nodeId?: unknown; blockingField?: unknown } | undefined;
  const body = config.body as WorkflowGraphDefinition | undefined;
  if (!qualityGate || typeof qualityGate.nodeId !== "string" || typeof qualityGate.blockingField !== "string") {
    invalid();
  } else if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)
    || !body.nodes.some((candidate) => candidate?.id === qualityGate.nodeId)) {
    invalid();
  }

  if (body && Array.isArray(body.nodes) && Array.isArray(body.edges)) {
    if (validateWorkflowGraph(body).errors.length > 0) {
      invalid();
    }
  }

  return errors;
}

/**
 * Compiles every `iteration_group` node into a statically-unrolled DAG the
 * current executor can run: `maxRounds` copies of the body, the round gate
 * feeding the next round's entry, and the final gate feeding an `approval`
 * (overLimit=approval) or ending at the gate (overLimit=fail). The coordinator
 * applies the `__iterationGate` marker after a gate completes to skip remaining
 * rounds when the blocking field reaches zero.
 */
export function compileWorkflowIterationGroups(graph: WorkflowGraphDefinition): WorkflowGraphDefinition {
  const nodes: WorkflowNodeDefinition[] = [];
  const edges: WorkflowEdgeDefinition[] = [];
  const unrolled = new Map<string, { entry: string; exit: string }>();

  for (const node of graph.nodes) {
    if (node.type !== "iteration_group") {
      nodes.push(node);
      continue;
    }
    const config = node.config as unknown as WorkflowIterationGroupConfig;
    const body = compileWorkflowIterationGroups(config.body);
    const entryNodeId = body.nodes.find((candidate) => !body.edges.some((edge) => edge.target === candidate.id))?.id;
    const gateNodeId = config.qualityGate.nodeId;
    if (!entryNodeId) {
      throw new Error(`Iteration group "${node.id}" body has no entry node.`);
    }

    const roundEntryIds: string[] = [];
    const roundGateIds: string[] = [];
    const roundNodeIds: string[][] = [];
    for (let round = 1; round <= config.maxRounds; round += 1) {
      const suffix = `-r${round}`;
      const idMap = new Map<string, string>();
      const thisRoundNodeIds: string[] = [];
      for (const bodyNode of body.nodes) {
        const newId = `${node.id}.${bodyNode.id}${suffix}`;
        idMap.set(bodyNode.id, newId);
        thisRoundNodeIds.push(newId);
        nodes.push({ ...bodyNode, id: newId, config: { ...bodyNode.config } });
      }
      for (const bodyEdge of body.edges) {
        edges.push({ source: idMap.get(bodyEdge.source)!, target: idMap.get(bodyEdge.target)! });
      }
      roundEntryIds.push(idMap.get(entryNodeId)!);
      roundGateIds.push(idMap.get(gateNodeId)!);
      roundNodeIds.push(thisRoundNodeIds);
    }

    // Round r gate -> round r+1 entry (block -> next round).
    for (let round = 1; round < config.maxRounds; round += 1) {
      edges.push({ source: roundGateIds[round - 1]!, target: roundEntryIds[round]! });
    }

    let approvalId: string | undefined;
    let exitId: string;
    if (config.overLimit === "approval") {
      approvalId = `${node.id}.over-limit-approval`;
      nodes.push({ id: approvalId, type: "approval", config: config.overLimitApproval ?? {} });
      edges.push({ source: roundGateIds[roundGateIds.length - 1]!, target: approvalId });
      exitId = approvalId;
    } else {
      exitId = roundGateIds[roundGateIds.length - 1]!;
    }
    unrolled.set(node.id, { entry: roundEntryIds[0]!, exit: exitId });

    // Early-exit marker (approval mode only): when a gate passes, the runtime
    // coordinator skips the remaining rounds and auto-approves the over-limit
    // approval (converged -> no human decision). "fail" mode keeps static
    // unrolling without early exit.
    if (approvalId) {
      for (let round = 1; round <= config.maxRounds; round += 1) {
        const gateNode = nodes.find((candidate) => candidate.id === roundGateIds[round - 1]!);
        if (!gateNode) continue;
        gateNode.config = {
          ...gateNode.config,
          __iterationGate: {
            blockingField: config.qualityGate.blockingField,
            skipRoundNodeIds: roundNodeIds.slice(round).flat(),
            approvalNodeId: approvalId,
          },
        };
      }
    }
  }

  // Remap external edges through the unrolled entry/exit points.
  for (const edge of graph.edges) {
    const source = unrolled.get(edge.source)?.exit ?? edge.source;
    const target = unrolled.get(edge.target)?.entry ?? edge.target;
    edges.push({ source, target });
  }

  return { schemaVersion: 1, nodes, edges };
}
