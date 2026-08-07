import type { WorkflowPublishValidation } from "@dofe-agent/services";
import { translateWorkflowErrorCode, type TxFn } from "@/features/i18n/presentation";

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

export function workflowPreflightBlockerLabel(code: string, tx?: TxFn): string {
  return translateWorkflowErrorCode(code, tx);
}
