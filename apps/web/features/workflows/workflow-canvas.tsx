"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { validateWorkflowGraph, type WorkflowGraphDefinition } from "@dofe-agent/domain";
import type { WorkflowDraftEvent } from "./workflow-builder-reducer";
import { WorkflowNodeConfigPanel } from "./workflow-node-config-panel";
import { WorkflowNodeListView, workflowNodeLabel, type WorkflowEmployeeOption } from "./workflow-node-list-view";

export interface WorkflowCanvasProps {
  graph: WorkflowGraphDefinition;
  employees: WorkflowEmployeeOption[];
  members?: Array<{ userId: string; displayName: string }>;
  selectedNodeId?: string;
  errorNodeIds?: string[];
  onSelectNode: (nodeId: string) => void;
  onEvent: (event: WorkflowDraftEvent) => void;
}

const EMPTY_ERROR_NODE_IDS: string[] = [];

export function WorkflowCanvas({
  graph,
  employees,
  members,
  selectedNodeId,
  errorNodeIds = EMPTY_ERROR_NODE_IDS,
  onSelectNode,
  onEvent,
}: WorkflowCanvasProps) {
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [isAdding, setIsAdding] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const initial = useMemo(() => toCanvasGraph(graph, employees, new Set(errorNodeIds)), [employees, errorNodeIds, graph]);
  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  useEffect(() => setNodes(initial.nodes), [initial.nodes]);
  useEffect(() => {
    if (view !== "canvas" || !flowInstance.current || initial.nodes.length === 0) return;
    let frame = 0;
    const refit = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void flowInstance.current?.fitView({ duration: 200, padding: 0.2 });
      });
    };
    refit();
    window.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      cancelAnimationFrame(frame);
    };
  }, [initial.edges, initial.nodes, view]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const errorSet = useMemo(() => new Set(errorNodeIds), [errorNodeIds]);

  function addEmployeeNode(): void {
    if (!employeeId) return;
    const nodeId = nextNodeId(graph);
    onEvent({ type: "addEmployeeNode", nodeId, employeeId });
    onSelectNode(nodeId);
    setEmployeeId("");
    setIsAdding(false);
  }

  function addApprovalNode(): void {
    const nodeId = nextApprovalNodeId(graph);
    onEvent({ type: "addApprovalNode", nodeId, employeeId: "", channelName: "" });
    onSelectNode(nodeId);
  }

  function handleNodesChange(changes: NodeChange<Node>[]): void {
    setNodes((current) => applyNodeChanges(changes, current));
  }

  function handleConnect(connection: Connection): void {
    const event = fromCanvasConnection(connection);
    if (event) onEvent(event);
  }

  return (
    <div className="workflow-builder-surface">
      <div className="workflow-builder-toolbar">
        <div aria-label="流程视图" className="workflow-segmented" role="tablist">
          <button aria-controls="workflow-structure-view" aria-selected={view === "canvas"} id="workflow-view-canvas" onClick={() => setView("canvas")} role="tab" type="button">画布</button>
          <button aria-controls="workflow-structure-view" aria-selected={view === "list"} id="workflow-view-list" onClick={() => setView("list")} role="tab" type="button">列表</button>
        </div>
        <div className="workflow-builder-toolbar__actions">
          <button className="knowledge-btn" onClick={addApprovalNode} type="button">添加审批步骤</button>
          <button className="knowledge-btn knowledge-btn--primary" onClick={() => setIsAdding((current) => !current)} type="button">添加 AI 员工步骤</button>
        </div>
      </div>

      {isAdding ? (
        <div className="workflow-builder-add">
          <label>
            <span>AI 员工</span>
            <select onChange={(event) => setEmployeeId(event.target.value)} value={employeeId}>
              <option value="">选择员工</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <button className="knowledge-btn knowledge-btn--primary" disabled={!employeeId} onClick={addEmployeeNode} type="button">添加</button>
        </div>
      ) : null}

      <div className="workflow-builder-grid">
        <div
          aria-labelledby={view === "canvas" ? "workflow-view-canvas" : "workflow-view-list"}
          className="workflow-builder-viewport"
          id="workflow-structure-view"
          role="tabpanel"
        >
          {view === "canvas" ? (
            <ReactFlow
              edges={initial.edges}
              fitView
              nodes={nodes}
              nodesConnectable
              nodesDraggable
              onConnect={handleConnect}
              onInit={(instance) => { flowInstance.current = instance; }}
              onNodeClick={(_event, node) => onSelectNode(node.id)}
              onNodesChange={handleNodesChange}
            >
              <Background gap={20} size={1} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          ) : (
            <WorkflowNodeListView
              employees={employees}
              errorNodeIds={errorSet}
              graph={graph}
              onSelectNode={onSelectNode}
              selectedNodeId={selectedNodeId}
            />
          )}
        </div>
        {selectedNode ? (
          <WorkflowNodeConfigPanel employees={employees} graph={graph} members={members} node={selectedNode} onEvent={onEvent} />
        ) : (
          <aside aria-label="步骤配置" className="workflow-node-config workflow-node-config--empty">选择一个步骤</aside>
        )}
      </div>
    </div>
  );
}

export function toCanvasGraph(
  graph: WorkflowGraphDefinition,
  employees: WorkflowEmployeeOption[],
  errorNodeIds = new Set<string>(),
): { nodes: Node[]; edges: Edge[] } {
  const positions = layoutGraph(graph);
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      data: { label: workflowNodeLabel(node, employees) },
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      style: {
        width: 180,
        minWidth: 180,
        maxWidth: 180,
        height: 64,
        borderColor: errorNodeIds.has(node.id) ? "var(--danger)" : "var(--line-strong)",
        background: "var(--bg-strong)",
        color: "var(--text)",
      },
      className: errorNodeIds.has(node.id) ? "workflow-canvas-node workflow-canvas-node--error" : "workflow-canvas-node",
    })),
    edges: graph.edges.map((edge) => ({ id: `${edge.source}:${edge.target}`, source: edge.source, target: edge.target })),
  };
}

export function fromCanvasConnection(connection: Connection): WorkflowDraftEvent | null {
  if (!connection.source || !connection.target || connection.source === connection.target) return null;
  return { type: "connect", source: connection.source, target: connection.target };
}

function layoutGraph(graph: WorkflowGraphDefinition): Map<string, { x: number; y: number }> {
  const order = validateWorkflowGraph(graph).topologicalOrder;
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  const levels = new Map<string, number>();
  for (const nodeId of order) {
    const parentLevels = (incoming.get(nodeId) ?? []).map((parent) => levels.get(parent) ?? 0);
    levels.set(nodeId, parentLevels.length > 0 ? Math.max(...parentLevels) + 1 : 0);
  }
  const lanes = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 0;
    const lane = lanes.get(level) ?? 0;
    lanes.set(level, lane + 1);
    positions.set(node.id, { x: level * 240 + 36, y: lane * 110 + 36 });
  }
  return positions;
}

function nextNodeId(graph: WorkflowGraphDefinition): string {
  let index = graph.nodes.length + 1;
  while (graph.nodes.some((node) => node.id === `employee-${index}`)) index += 1;
  return `employee-${index}`;
}

function nextApprovalNodeId(graph: WorkflowGraphDefinition): string {
  let index = graph.nodes.filter((node) => node.type === "approval").length + 1;
  while (graph.nodes.some((node) => node.id === `approval-${index}`)) index += 1;
  return `approval-${index}`;
}
