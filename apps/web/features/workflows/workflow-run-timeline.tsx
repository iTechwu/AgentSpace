import type { WorkflowRunEventItem } from "./workflow-types";

export function WorkflowRunTimeline({ events }: { events: WorkflowRunEventItem[] }) {
  return (
    <section aria-labelledby="workflow-run-timeline-title" className="workflow-run-timeline">
      <header>
        <h2 id="workflow-run-timeline-title">运行时间线</h2>
        <span>{events.length} 条事件</span>
      </header>
      {events.length === 0 ? <p className="workflow-run-timeline__empty">尚无运行事件</p> : (
        <ol>
          {events.map((event) => (
            <li data-severity={event.severity} key={event.id}>
              <span className="workflow-run-timeline__sequence">#{event.sequence}</span>
              <div>
                <strong>{workflowEventLabel(event.type)}</strong>
                <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function workflowEventLabel(type: string): string {
  const labels: Record<string, string> = {
    "workflow.run.created": "运行已创建",
    "workflow.run.started": "运行已开始",
    "workflow.run.paused": "运行已暂停",
    "workflow.run.resumed": "运行已恢复",
    "workflow.run.cancelled": "运行已取消",
    "workflow.run.succeeded": "运行已完成",
    "workflow.run.failed": "运行失败",
    "workflow.node.ready": "步骤已就绪",
    "workflow.node.queued": "步骤已排队",
    "workflow.node.started": "步骤开始执行",
    "workflow.node.succeeded": "步骤执行完成",
    "workflow.node.failed": "步骤执行失败",
    "workflow.node.retry_scheduled": "步骤等待重试",
    "run.paused": "运行已暂停",
    "run.resumed": "运行已恢复",
    "run.cancelled": "运行已取消",
    "node.retry_scheduled": "步骤等待重试",
  };
  return labels[type] ?? "工作流状态已更新";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
