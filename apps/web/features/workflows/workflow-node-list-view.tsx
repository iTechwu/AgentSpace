import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { AppIcon } from "@/shared/ui/app-icon";

export interface WorkflowEmployeeOption {
  id: string;
  name: string;
  status?: string;
}

export function WorkflowNodeListView({
  graph,
  employees,
  selectedNodeId,
  errorNodeIds,
  onSelectNode,
}: {
  graph: WorkflowGraphDefinition;
  employees: WorkflowEmployeeOption[];
  selectedNodeId?: string;
  errorNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
}) {
  const labels = new Map(graph.nodes.map((node) => [node.id, workflowNodeLabel(node, employees)]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  const boundaries = workflowGraphBoundaries(graph);
  const entryLabel = boundaries.entryNodeId ? labels.get(boundaries.entryNodeId) : undefined;
  const terminalNode = graph.nodes.find((node) => node.id === boundaries.terminalNodeId);
  const terminalLabel = terminalNode ? labels.get(terminalNode.id) : undefined;
  return (
    <ol aria-label="流程结构" className="workflow-node-list">
      {entryLabel ? (
        <li className="workflow-node-list__boundary">
          <AppIcon name="arrowRight" />
          <span><strong>开始</strong><small>触发后进入 {entryLabel}</small></span>
        </li>
      ) : null}
      {graph.nodes.map((node, index) => {
        const targets = outgoing.get(node.id) ?? [];
        return (
          <li data-error={errorNodeIds.has(node.id) || undefined} data-testid={`node-${node.id}`} key={node.id}>
            <button
              aria-current={selectedNodeId === node.id ? "step" : undefined}
              onClick={() => onSelectNode(node.id)}
              type="button"
            >
              <span className="workflow-node-list__index">{index + 1}</span>
              <span className="workflow-node-list__copy">
                <strong title={labels.get(node.id)}>{labels.get(node.id)}</strong>
                <small>{node.id === boundaries.terminalNodeId && node.type !== "join" ? "最终交付者" : node.type}</small>
              </span>
              {targets.length > 0 ? <span aria-label="连接到">→ {targets.map((id) => labels.get(id) ?? id).join(" / ")}</span> : null}
            </button>
          </li>
        );
      })}
      {terminalLabel ? (
        <li className={`workflow-node-list__boundary${terminalNode?.type === "join" ? " workflow-node-list__boundary--incomplete" : " workflow-node-list__boundary--delivery"}`}>
          <AppIcon name={terminalNode?.type === "join" ? "alertCircle" : "checkCircle"} />
          <span>
            <strong>{terminalNode?.type === "join" ? "最终交付未设置" : "最终交付"}</strong>
            <small>{terminalNode?.type === "join" ? "请在汇总步骤后添加交付员工" : `来自 ${terminalLabel} 的执行结果`}</small>
          </span>
        </li>
      ) : null}
    </ol>
  );
}

export function workflowGraphBoundaries(graph: WorkflowGraphDefinition): {
  entryNodeId?: string;
  terminalNodeId?: string;
} {
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (incoming.has(edge.target)) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    if (outgoing.has(edge.source)) outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }
  const entries = graph.nodes.filter((node) => incoming.get(node.id) === 0);
  const terminals = graph.nodes.filter((node) => outgoing.get(node.id) === 0);
  return {
    entryNodeId: entries.length === 1 ? entries[0]!.id : undefined,
    terminalNodeId: terminals.length === 1 ? terminals[0]!.id : undefined,
  };
}

export function workflowNodeLabel(
  node: WorkflowGraphDefinition["nodes"][number],
  employees: WorkflowEmployeeOption[],
): string {
  if (node.type === "join") return "汇总步骤";
  if (node.type === "approval") return "审批步骤";
  const employee = employees.find((item) => item.id === node.employeeId);
  return employee?.name ?? (typeof node.config.label === "string" ? node.config.label : "AI 员工步骤");
}
