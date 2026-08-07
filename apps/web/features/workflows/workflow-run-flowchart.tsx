"use client";

import { useMemo } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { translateWorkflowNodeStatus, type TxFn } from "@/features/i18n/presentation";
import type { WorkflowNodeRunItem } from "./workflow-types";

/**
 * 运行详情只读流程图（UIUX:运行详情可扩展流程图）。
 *
 * 现有「执行步骤」是一个扁平 <ol>，无法表达并行分支与汇聚拓扑；当节点数变多时也不
 * 易纵览。这里复用编排画布同款 @xyflow/react，按运行绑定版本的边做拓扑分层布局，
 * 并用节点状态着色，配合 MiniMap/Controls 提供平移缩放，使大图也能承载。
 *
 * 可访问性（UIUX:52）：状态不以颜色单一表达——每个节点除边框/背景着色外，还显式
 * 渲染状态文本，色盲与读屏场景下也能获知各步骤当前状态。
 */
export function WorkflowRunFlowchart({
  nodes,
  edges,
  tx,
}: {
  nodes: WorkflowNodeRunItem[];
  edges: Array<{ source: string; target: string }>;
  tx: TxFn;
}) {
  const { flowNodes, flowEdges } = useMemo(() => buildRunFlow(nodes, edges, tx), [nodes, edges, tx]);
  if (nodes.length === 0) return null;
  return (
    <div aria-label="运行流程图" className="workflow-run-flow">
      <ReactFlow
        edges={flowEdges}
        fitView
        nodes={flowNodes}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
      >
        <Background gap={20} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// 节点状态 → 边框色；运行中用 accent，成功/失败/等待审批用语义色，终态中性节点收敛到次级文字色。
const STATUS_BORDER: Record<string, string> = {
  running: "var(--accent)",
  ready: "var(--accent)",
  succeeded: "var(--success)",
  failed: "var(--danger)",
  waiting_approval: "var(--warning)",
  cancelled: "var(--text-secondary)",
  skipped: "var(--text-secondary)",
};

// 节点状态 → 软背景色；未命中者回退到 --bg-strong，保持卡片可读。
const STATUS_SOFT: Record<string, string> = {
  running: "var(--accent-soft)",
  ready: "var(--accent-soft)",
  succeeded: "var(--success-soft)",
  failed: "var(--danger-soft)",
  waiting_approval: "var(--warning-soft)",
};

function buildRunFlow(
  nodes: WorkflowNodeRunItem[],
  edges: Array<{ source: string; target: string }>,
  tx: TxFn,
): { flowNodes: Node[]; flowEdges: Edge[] } {
  const positions = layoutRunGraph(nodes.map((node) => node.nodeId), edges);
  const flowNodes: Node[] = nodes.map((node) => {
    const statusText = translateWorkflowNodeStatus(node.status, tx);
    return {
      id: node.nodeId,
      position: positions.get(node.nodeId) ?? { x: 0, y: 0 },
      // 节点标签显式包含状态文本（UIUX:52），不依赖颜色单一表达状态。
      data: {
        label: (
          <div className="workflow-run-flow-node__label">
            <span className="workflow-run-flow-node__name">{node.employeeName || node.nodeType}</span>
            <span className="workflow-run-flow-node__status" data-status={node.status}>{statusText}</span>
          </div>
        ),
      },
      style: {
        width: 168,
        minWidth: 168,
        maxWidth: 168,
        height: 56,
        borderColor: STATUS_BORDER[node.status] ?? "var(--line-strong)",
        background: STATUS_SOFT[node.status] ?? "var(--bg-strong)",
        color: "var(--text)",
      },
      className: `workflow-run-flow-node workflow-run-flow-node--${node.status}`,
    };
  });
  const flowEdges: Edge[] = edges.map((edge) => ({
    id: `${edge.source}:${edge.target}`,
    source: edge.source,
    target: edge.target,
  }));
  return { flowNodes, flowEdges };
}

/**
 * 基于入度最长路径的拓扑分层布局：level = max(前驱 level) + 1，根节点为 0；
 * 同层节点沿纵轴堆叠。对环外的节点（理论上 DAG 不应出现）做兜底追加，避免死循环。
 */
function layoutRunGraph(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const present = new Set(nodeIds);
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    incoming.get(edge.target)!.add(edge.source);
    outgoing.get(edge.source)!.add(edge.target);
  }
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, incoming.get(id)!.size);
  const queue: string[] = nodeIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // 兜底：环内或孤立残留节点按原顺序追加（合法 DAG 不会触发）。
  for (const id of nodeIds) if (!order.includes(id)) order.push(id);

  const levels = new Map<string, number>();
  for (const id of order) {
    const parentLevels = [...incoming.get(id)!].map((parent) => levels.get(parent) ?? 0);
    levels.set(id, parentLevels.length > 0 ? Math.max(...parentLevels) + 1 : 0);
  }
  const lanes = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of order) {
    const level = levels.get(id) ?? 0;
    const lane = lanes.get(level) ?? 0;
    lanes.set(level, lane + 1);
    positions.set(id, { x: level * 240 + 24, y: lane * 96 + 24 });
  }
  return positions;
}
