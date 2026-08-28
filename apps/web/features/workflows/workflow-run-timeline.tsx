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
  // 事件码与引擎运行事件日志（appendWorkflowRunEventSync）一致，均为裸前缀；
  // workflow.* 前缀属于 outbox（外部集成）命名空间，不会写入运行时间线。
  const labels: Record<string, string> = {
    "run.created": "运行已创建",
    "run.queued": "运行已排队",
    "run.started": "运行已开始",
    "run.paused": "运行已暂停",
    "run.resumed": "运行已恢复",
    "run.cancelled": "运行已取消",
    "run.succeeded": "运行已完成",
    "run.partially_succeeded": "运行部分完成",
    "run.failed": "运行失败",
    "node.ready": "步骤已就绪",
    "node.queued": "步骤已排队",
    "node.started": "步骤开始执行",
    "node.succeeded": "步骤执行完成",
    "node.failed": "步骤执行失败",
    "node.skipped": "步骤已跳过",
    "node.retry_scheduled": "步骤等待重试",
    "node.dependency_blocked": "步骤依赖未就绪",
    "node.concurrency_wait": "步骤等待并发额度",
    "node.queue_blocked": "步骤入队受阻",
    "join.succeeded": "汇聚完成",
    "join.failed": "汇聚失败",
    "approval.requested": "审批已发起",
    "approval.approved": "审批通过",
    "approval.rejected": "审批驳回",
    "trigger.fired": "触发器已触发",
  };
  return labels[type] ?? "工作流状态已更新";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
