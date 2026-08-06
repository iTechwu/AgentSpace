import type { WorkflowGraphDefinition, WorkflowNodeDefinition } from "@dofe-agent/domain";
import type { WorkflowDraftEvent } from "./workflow-builder-reducer";
import { workflowNodeLabel, type WorkflowEmployeeOption } from "./workflow-node-list-view";

export function WorkflowNodeConfigPanel({
  node,
  graph,
  employees,
  onEvent,
}: {
  node: WorkflowNodeDefinition;
  graph: WorkflowGraphDefinition;
  employees: WorkflowEmployeeOption[];
  onEvent: (event: WorkflowDraftEvent) => void;
}) {
  const targets = graph.nodes.filter((candidate) => candidate.id !== node.id);
  const retry = typeof node.config.retry === "object" && node.config.retry
    ? node.config.retry as { maxAttempts?: number }
    : {};
  return (
    <aside aria-label="步骤配置" className="workflow-node-config">
      <header>
        <div>
          <span>{node.type}</span>
          <h2 title={workflowNodeLabel(node, employees)}>{workflowNodeLabel(node, employees)}</h2>
        </div>
        <button aria-label="删除步骤" className="knowledge-btn knowledge-btn--danger" onClick={() => onEvent({ type: "removeNode", nodeId: node.id })} type="button">删除</button>
      </header>
      {node.type === "employee_task" ? (
        <>
          <label>
            <span>AI 员工</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { employeeId: event.target.value } })}
              value={node.employeeId ?? ""}
            >
              <option value="">选择员工</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>
            <span>任务说明</span>
            <textarea
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, instruction: event.target.value } } })}
              rows={5}
              value={typeof node.config.instruction === "string" ? node.config.instruction : ""}
            />
          </label>
          <label>
            <span>最大尝试次数</span>
            <input
              max={10}
              min={1}
              onChange={(event) => onEvent({
                type: "updateNode",
                nodeId: node.id,
                patch: { config: { ...node.config, retry: { ...retry, maxAttempts: Number(event.target.value) } } },
              })}
              type="number"
              value={retry.maxAttempts ?? 1}
            />
          </label>
        </>
      ) : null}
      {node.type === "join" ? (
        <label>
          <span>汇聚策略</span>
          <select
            onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, policy: event.target.value } } })}
            value={typeof node.config.policy === "string" ? node.config.policy : "all_success"}
          >
            <option value="all_success">全部成功后继续</option>
            <option value="allow_partial">允许部分结果</option>
          </select>
        </label>
      ) : null}
      {node.type === "approval" ? (
        <>
          <label>
            <span>提交审批的 AI 员工</span>
            <select
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, employeeId: event.target.value } } })}
              value={typeof node.config.employeeId === "string" ? node.config.employeeId : ""}
            >
              <option value="">选择员工</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>
            <span>审批频道</span>
            <input
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, channelName: event.target.value } } })}
              value={typeof node.config.channelName === "string" ? node.config.channelName : ""}
            />
          </label>
          <label>
            <span>审批说明</span>
            <textarea
              onChange={(event) => onEvent({ type: "updateNode", nodeId: node.id, patch: { config: { ...node.config, instruction: event.target.value } } })}
              rows={4}
              value={typeof node.config.instruction === "string" ? node.config.instruction : ""}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>连接到</span>
        <select
          aria-label="连接到"
          onChange={(event) => {
            if (event.target.value) onEvent({ type: "connect", source: node.id, target: event.target.value });
            event.target.value = "";
          }}
          value=""
        >
          <option value="">选择下游步骤</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{workflowNodeLabel(target, employees)}</option>)}
        </select>
      </label>
    </aside>
  );
}
