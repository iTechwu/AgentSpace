import type { WorkflowGraphDefinition } from "@dofe-agent/domain";

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
  return (
    <ol aria-label="流程结构" className="workflow-node-list">
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
                <small>{node.type}</small>
              </span>
              {targets.length > 0 ? <span aria-label="连接到">→ {targets.map((id) => labels.get(id) ?? id).join(" / ")}</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
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
