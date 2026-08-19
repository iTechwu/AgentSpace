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
import { AppIcon } from "@/shared/ui/app-icon";
import type { WorkflowDraftEvent } from "./workflow-builder-reducer";
import { WorkflowNodeConfigPanel } from "./workflow-node-config-panel";
import {
  WorkflowNodeListView,
  workflowGraphBoundaries,
  workflowNodeLabel,
  type WorkflowEmployeeOption,
} from "./workflow-node-list-view";

export interface WorkflowCanvasProps {
  graph: WorkflowGraphDefinition;
  employees: WorkflowEmployeeOption[];
  members?: Array<{ userId: string; displayName: string }>;
  selectedNodeId?: string;
  errorNodeIds?: string[];
  onSelectNode: (nodeId?: string) => void;
  onEvent: (event: WorkflowDraftEvent) => void;
  onOpenParallelBuilder?: () => void;
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
  onOpenParallelBuilder,
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
        <span>{graph.nodes.length === 0 ? "还没有步骤" : `${graph.nodes.length} 个步骤`}</span>
      </div>

      <div className={`workflow-builder-grid${selectedNode ? " workflow-builder-grid--config" : ""}`}>
        <aside aria-label="步骤库" className="workflow-builder-palette">
          <header><strong>步骤库</strong><span>点击添加</span></header>
          <button aria-expanded={isAdding} aria-label="添加 AI 员工步骤" className="workflow-builder-palette__item" onClick={() => setIsAdding((current) => !current)} type="button">
            <span className="workflow-builder-palette__icon"><AppIcon name="agents" /></span>
            <span><strong>AI 员工</strong><small>执行一项任务</small></span>
            <AppIcon name="plus" />
          </button>
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
          <button className="workflow-builder-palette__item" onClick={addApprovalNode} type="button">
            <span className="workflow-builder-palette__icon"><AppIcon name="approvals" /></span>
            <span><strong>人工审批</strong><small>等待确认后继续</small></span>
            <AppIcon name="plus" />
          </button>
          {onOpenParallelBuilder ? (
            <button className="workflow-builder-palette__item" onClick={onOpenParallelBuilder} type="button">
              <span className="workflow-builder-palette__icon"><AppIcon name="orgChart" /></span>
              <span><strong>并行分支</strong><small>同时执行并汇聚</small></span>
              <AppIcon name="plus" />
            </button>
          ) : null}
        </aside>
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
              onNodeClick={(_event, node) => {
                if (graph.nodes.some((definition) => definition.id === node.id)) onSelectNode(node.id);
              }}
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
          <WorkflowNodeConfigPanel employees={employees} graph={graph} members={members} node={selectedNode} onClose={() => onSelectNode(undefined)} onEvent={onEvent} />
        ) : null}
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
  const boundaries = workflowGraphBoundaries(graph);
  const entryPosition = boundaries.entryNodeId ? positions.get(boundaries.entryNodeId) : undefined;
  const terminalPosition = boundaries.terminalNodeId ? positions.get(boundaries.terminalNodeId) : undefined;
  const terminalNode = graph.nodes.find((node) => node.id === boundaries.terminalNodeId);
  const startId = uniqueBoundaryId(graph, "start");
  const deliveryId = uniqueBoundaryId(graph, "delivery");
  const boundaryNodes: Node[] = [];
  const boundaryEdges: Edge[] = [];

  if (boundaries.entryNodeId && entryPosition) {
    boundaryNodes.push(workflowBoundaryNode({
      id: startId,
      kind: "start",
      position: { x: entryPosition.x - 180, y: entryPosition.y + 5 },
      subtitle: "接收触发输入",
    }));
    boundaryEdges.push({
      id: `${startId}:${boundaries.entryNodeId}`,
      source: startId,
      target: boundaries.entryNodeId,
      className: "workflow-canvas-edge--boundary",
    });
  }
  if (boundaries.terminalNodeId && terminalPosition && terminalNode) {
    const terminalLabel = workflowNodeLabel(terminalNode, employees);
    const incomplete = terminalNode.type === "join";
    boundaryNodes.push(workflowBoundaryNode({
      id: deliveryId,
      kind: incomplete ? "incomplete" : "delivery",
      position: { x: terminalPosition.x + 240, y: terminalPosition.y + 5 },
      subtitle: incomplete ? "还需添加交付员工" : `来自 ${terminalLabel}`,
    }));
    boundaryEdges.push({
      id: `${boundaries.terminalNodeId}:${deliveryId}`,
      source: boundaries.terminalNodeId,
      target: deliveryId,
      className: `workflow-canvas-edge--boundary${incomplete ? " workflow-canvas-edge--incomplete" : ""}`,
    });
  }
  return {
    nodes: [
      ...boundaryNodes,
      ...graph.nodes.map((node) => {
        const isDeliveryNode = node.id === boundaries.terminalNodeId && node.type !== "join";
        return {
          id: node.id,
          data: {
            label: (
              <span className="workflow-canvas-node__label">
                <strong>{workflowNodeLabel(node, employees)}</strong>
                {isDeliveryNode ? <small>最终交付者</small> : null}
              </span>
            ),
          },
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          style: {
            width: 180,
            minWidth: 180,
            maxWidth: 180,
            height: 64,
            borderColor: errorNodeIds.has(node.id) ? "var(--danger)" : isDeliveryNode ? "var(--success)" : "var(--line-strong)",
            background: "var(--bg-strong)",
            color: "var(--text)",
          },
          className: [
            "workflow-canvas-node",
            errorNodeIds.has(node.id) ? "workflow-canvas-node--error" : "",
            isDeliveryNode ? "workflow-canvas-node--delivery" : "",
          ].filter(Boolean).join(" "),
        } satisfies Node;
      }),
    ],
    edges: [
      ...boundaryEdges,
      ...graph.edges.map((edge) => ({ id: `${edge.source}:${edge.target}`, source: edge.source, target: edge.target })),
    ],
  };
}

function workflowBoundaryNode(input: {
  id: string;
  kind: "start" | "delivery" | "incomplete";
  position: { x: number; y: number };
  subtitle: string;
}): Node {
  const title = input.kind === "start" ? "开始" : input.kind === "delivery" ? "最终交付" : "交付未设置";
  const icon = input.kind === "start" ? "arrowRight" : input.kind === "delivery" ? "checkCircle" : "alertCircle";
  return {
    id: input.id,
    data: {
      label: (
        <span className="workflow-canvas-boundary__label">
          <AppIcon name={icon} />
          <span><strong>{title}</strong><small>{input.subtitle}</small></span>
        </span>
      ),
    },
    position: input.position,
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
    style: { width: 140, minWidth: 140, maxWidth: 140, height: 54 },
    className: `workflow-canvas-boundary workflow-canvas-boundary--${input.kind}`,
  };
}

function uniqueBoundaryId(graph: WorkflowGraphDefinition, kind: "start" | "delivery"): string {
  const prefix = `__workflow_boundary_${kind}__`;
  let id = prefix;
  let suffix = 1;
  while (graph.nodes.some((node) => node.id === id)) {
    id = `${prefix}-${suffix}`;
    suffix += 1;
  }
  return id;
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
