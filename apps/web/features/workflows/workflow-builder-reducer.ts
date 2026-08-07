import type {
  WorkflowEdgeDefinition,
  WorkflowGraphDefinition,
  WorkflowNodeDefinition,
} from "@dofe-agent/domain";

const HISTORY_LIMIT = 50;

export interface WorkflowDraftState extends WorkflowGraphDefinition {
  past: WorkflowGraphDefinition[];
  future: WorkflowGraphDefinition[];
  dirty: boolean;
  draftVersion: number;
  savedGraph: WorkflowGraphDefinition;
}

export type WorkflowDraftEvent =
  | { type: "addEmployeeNode"; nodeId: string; employeeId: string }
  | { type: "addApprovalNode"; nodeId: string; employeeId: string; channelName: string }
  | {
      type: "addParallelGroup";
      sourceNodeId: string;
      branches: Array<{ id: string; employeeId: string }>;
      joinId: string;
    }
  | { type: "connect"; source: string; target: string }
  | { type: "updateNode"; nodeId: string; patch: Partial<Omit<WorkflowNodeDefinition, "id">> }
  | { type: "removeNode"; nodeId: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "markSaved"; canonical: WorkflowGraphDefinition; draftVersion: number };

export function createEmptyWorkflowDraft(): WorkflowDraftState {
  return createWorkflowDraftState({ schemaVersion: 1, nodes: [], edges: [] }, 0);
}

export function createWorkflowDraftState(
  graph: WorkflowGraphDefinition,
  draftVersion: number,
): WorkflowDraftState {
  const canonical = cloneGraph(graph);
  return {
    ...canonical,
    past: [],
    future: [],
    dirty: false,
    draftVersion,
    savedGraph: cloneGraph(canonical),
  };
}

export function workflowDraftReducer(
  state: WorkflowDraftState,
  event: WorkflowDraftEvent,
): WorkflowDraftState {
  if (event.type === "undo") return undo(state);
  if (event.type === "redo") return redo(state);
  if (event.type === "markSaved") {
    const canonical = cloneGraph(event.canonical);
    return {
      ...state,
      ...canonical,
      draftVersion: event.draftVersion,
      dirty: false,
      savedGraph: cloneGraph(canonical),
    };
  }

  const current = graphFromState(state);
  const next = reduceGraph(current, event);
  if (sameGraph(current, next)) return state;
  return {
    ...state,
    ...next,
    past: [...state.past, current].slice(-HISTORY_LIMIT),
    future: [],
    dirty: !sameGraph(next, state.savedGraph),
  };
}

function reduceGraph(
  graph: WorkflowGraphDefinition,
  event: Exclude<WorkflowDraftEvent, { type: "undo" | "redo" | "markSaved" }>,
): WorkflowGraphDefinition {
  if (event.type === "addEmployeeNode") {
    if (hasNode(graph, event.nodeId)) return graph;
    return {
      ...graph,
      nodes: [...graph.nodes, employeeNode(event.nodeId, event.employeeId)],
    };
  }
  if (event.type === "addApprovalNode") {
    if (hasNode(graph, event.nodeId)) return graph;
    return {
      ...graph,
      nodes: [...graph.nodes, {
        id: event.nodeId,
        type: "approval",
        config: {
          employeeId: event.employeeId,
          channelName: event.channelName,
          instruction: "请审批上游步骤的交付结果。",
        },
      }],
    };
  }
  if (event.type === "addParallelGroup") {
    if (!hasNode(graph, event.sourceNodeId) || event.branches.length < 2) return graph;
    const ids = [...event.branches.map((branch) => branch.id), event.joinId];
    if (new Set(ids).size !== ids.length || ids.some((id) => hasNode(graph, id))) return graph;
    const branchNodes = event.branches.map((branch) => employeeNode(branch.id, branch.employeeId));
    const edges = event.branches.flatMap((branch): WorkflowEdgeDefinition[] => [
      { source: event.sourceNodeId, target: branch.id },
      { source: branch.id, target: event.joinId },
    ]);
    return {
      ...graph,
      nodes: [...graph.nodes, ...branchNodes, { id: event.joinId, type: "join", config: { policy: "all_success" } }],
      edges: uniqueEdges([...graph.edges, ...edges]),
    };
  }
  if (event.type === "connect") {
    if (!hasNode(graph, event.source) || !hasNode(graph, event.target) || event.source === event.target) return graph;
    return { ...graph, edges: uniqueEdges([...graph.edges, { source: event.source, target: event.target }]) };
  }
  if (event.type === "updateNode") {
    if (!hasNode(graph, event.nodeId)) return graph;
    return {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === event.nodeId
        ? { ...node, ...event.patch, id: node.id, config: event.patch.config ?? node.config }
        : node),
    };
  }
  if (!hasNode(graph, event.nodeId)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== event.nodeId),
    edges: graph.edges.filter((edge) => edge.source !== event.nodeId && edge.target !== event.nodeId),
  };
}

function undo(state: WorkflowDraftState): WorkflowDraftState {
  const previous = state.past.at(-1);
  if (!previous) return state;
  const current = graphFromState(state);
  return {
    ...state,
    ...cloneGraph(previous),
    past: state.past.slice(0, -1),
    future: [current, ...state.future].slice(0, HISTORY_LIMIT),
    dirty: !sameGraph(previous, state.savedGraph),
  };
}

function redo(state: WorkflowDraftState): WorkflowDraftState {
  const next = state.future[0];
  if (!next) return state;
  const current = graphFromState(state);
  return {
    ...state,
    ...cloneGraph(next),
    past: [...state.past, current].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
    dirty: !sameGraph(next, state.savedGraph),
  };
}

function employeeNode(id: string, employeeId: string): WorkflowNodeDefinition {
  return { id, type: "employee_task", employeeId, config: {} };
}

function graphFromState(state: WorkflowDraftState): WorkflowGraphDefinition {
  return cloneGraph({ schemaVersion: 1, nodes: state.nodes, edges: state.edges });
}

function cloneGraph(graph: WorkflowGraphDefinition): WorkflowGraphDefinition {
  return {
    schemaVersion: 1,
    nodes: graph.nodes.map((node) => ({ ...node, config: { ...node.config } })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function sameGraph(left: WorkflowGraphDefinition, right: WorkflowGraphDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasNode(graph: WorkflowGraphDefinition, nodeId: string): boolean {
  return graph.nodes.some((node) => node.id === nodeId);
}

function uniqueEdges(edges: WorkflowEdgeDefinition[]): WorkflowEdgeDefinition[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\0${edge.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
