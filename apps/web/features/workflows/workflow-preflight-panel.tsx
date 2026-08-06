import type { WorkflowPublishValidation } from "@dofe-agent/services";

export function WorkflowPreflightPanel({
  validation,
  isPending,
  onRun,
  onFocusNode,
}: {
  validation: WorkflowPublishValidation | null;
  isPending: boolean;
  onRun: () => void;
  onFocusNode: (nodeId: string) => void;
}) {
  return (
    <section aria-labelledby="workflow-preflight-title" className="workflow-preflight" aria-live="polite">
      <div className="workflow-preflight__header">
        <div>
          <h2 id="workflow-preflight-title">发布预检</h2>
          <p>{preflightSummary(validation)}</p>
        </div>
        <button className="knowledge-btn" disabled={isPending} onClick={onRun} type="button">
          {isPending ? "正在预检" : "运行预检"}
        </button>
      </div>
      {validation?.blockers.length ? (
        <ul aria-label="预检阻塞项" className="workflow-preflight__issues">
          {validation.blockers.map((blocker, index) => (
            <li key={`${blocker.code}:${blocker.nodeId ?? index}`}>
              <div>
                <strong>{workflowPreflightBlockerLabel(blocker.code)}</strong>
                <span>{blocker.nodeId ? `步骤 ${blocker.nodeId}` : "工作流设置"}</span>
              </div>
              {blocker.nodeId ? (
                <button className="knowledge-btn" onClick={() => onFocusNode(blocker.nodeId!)} type="button">定位步骤</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {validation?.warnings.length ? (
        <ul aria-label="预检提示" className="workflow-preflight__warnings">
          {validation.warnings.map((warning, index) => (
            <li key={`${warning.code}:${warning.nodeId ?? index}`}>{workflowPreflightBlockerLabel(warning.code)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function preflightSummary(validation: WorkflowPublishValidation | null): string {
  if (!validation) return "尚未预检";
  if (validation.blockers.length > 0) return `${validation.blockers.length} 项需要处理`;
  return "预检通过";
}

export function workflowPreflightBlockerLabel(code: string): string {
  const labels: Record<string, string> = {
    workflow_actor_forbidden: "当前成员没有发布权限",
    workflow_graph_requires_employee_task: "至少添加一个 AI 员工步骤",
    workflow_graph_cycle: "流程中不能存在循环连接",
    workflow_graph_multiple_entry_nodes: "流程只能有一个起点",
    workflow_graph_multiple_terminal_nodes: "流程只能有一个终点",
    workflow_graph_disconnected: "所有步骤必须连接到主流程",
    workflow_employee_task_requires_employee_id: "请选择执行此步骤的 AI 员工",
    workflow_employee_not_ready: "AI 员工运行环境尚未就绪",
    workflow_join_requires_multiple_inputs: "汇聚步骤至少需要两个并行输入",
    workflow_join_requires_downstream: "汇聚步骤后需要添加汇总员工",
  };
  return labels[code] ?? "工作流配置需要调整";
}
