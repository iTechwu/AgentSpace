"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { controlWorkflowRunAction } from "./workflow-actions";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import type { WorkflowRunEventItem, WorkflowRunPageData } from "./workflow-types";

const POLL_INTERVAL_MS = 2_500;
const TERMINAL_STATUSES = new Set(["succeeded", "partially_succeeded", "failed", "cancelled"]);

export function WorkflowRunClient({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: WorkflowRunPageData;
}) {
  const router = useRouter();
  const [projection, setProjection] = useState(data);
  const [events, setEvents] = useState(data.events);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingControl, setPendingControl] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const lastSequenceRef = useRef(lastSequence(data.events));

  const refreshFrom = useCallback(async (after: number): Promise<void> => {
    setIsSyncing(true);
    try {
      let cursor = after;
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/workflow-runs/${encodeURIComponent(data.id)}/events?after=${cursor}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("workflow_run_events_unavailable");
        const page = await response.json() as {
          events: WorkflowRunEventItem[];
          hasMore: boolean;
          projection: WorkflowRunPageData | null;
        };
        setEvents((current) => {
          const merged = mergeWorkflowRunEvents(current, page.events);
          lastSequenceRef.current = lastSequence(merged.events);
          return merged.events;
        });
        if (page.projection) setProjection(page.projection);
        cursor = Math.max(cursor, ...page.events.map((event) => event.sequence));
        hasMore = page.hasMore && page.events.length > 0;
      }
    } catch {
      setNotice("运行状态同步失败，将自动重试。");
    } finally {
      setIsSyncing(false);
    }
  }, [data.id, workspaceId]);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshFrom(lastSequenceRef.current), POLL_INTERVAL_MS);
    const handleRealtime = (event: Event): void => {
      const incoming = (event as CustomEvent<WorkflowRunEventItem>).detail;
      if (!incoming || typeof incoming.sequence !== "number") return;
      setEvents((current) => {
        const merged = mergeWorkflowRunEvents(current, [incoming]);
        if (merged.gapAfter !== undefined) {
          void refreshFrom(merged.gapAfter);
          return current;
        }
        lastSequenceRef.current = lastSequence(merged.events);
        return merged.events;
      });
    };
    window.addEventListener("workflow-run-event", handleRealtime);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("workflow-run-event", handleRealtime);
    };
  }, [refreshFrom]);

  async function control(action: "pause" | "resume" | "cancel" | "retry_node", nodeId?: string): Promise<void> {
    setPendingControl(`${action}:${nodeId ?? "run"}`);
    setNotice(undefined);
    try {
      const result = await controlWorkflowRunAction({ runId: projection.id, action, nodeId });
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
      setProjection((current) => ({ ...current, status: result.data.status }));
      setNotice("运行控制已提交。");
      await refreshFrom(lastSequenceRef.current);
      router.refresh();
    } catch {
      setNotice("运行控制未完成，请稍后重试。");
    } finally {
      setPendingControl(undefined);
    }
  }

  const canPause = projection.status === "running" || projection.status === "queued";
  const canResume = projection.status === "paused";
  const canCancel = !TERMINAL_STATUSES.has(projection.status);

  return (
    <main className="workflow-run">
      <header className="workflow-run__header">
        <div>
          <span>编排中心 / 运行详情</span>
          <h1>{projection.workflowName}</h1>
          <p>运行 ID {projection.id} · {triggerLabel(projection.triggerType)}</p>
        </div>
        <div className="workflow-run__header-state">
          <strong data-status={projection.status}>{runStatusLabel(projection.status)}</strong>
          <div className="workflow-run__controls">
            {canPause ? <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("pause")} type="button">暂停</button> : null}
            {canResume ? <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("resume")} type="button">恢复</button> : null}
            {canCancel ? <button className="knowledge-btn knowledge-btn--danger" disabled={Boolean(pendingControl)} onClick={() => void control("cancel")} type="button">取消</button> : null}
          </div>
        </div>
      </header>

      {isSyncing ? <p className="workflow-run__sync" role="status">正在同步缺失事件</p> : null}
      {notice ? <p className="workflow-run__notice" role="status">{notice}</p> : null}

      <section aria-labelledby="workflow-run-steps-title" className="workflow-run__steps">
        <header><h2 id="workflow-run-steps-title">执行步骤</h2><span>{projection.nodes.length} 个节点</span></header>
        <ol>
          {projection.nodes.map((node) => (
            <li key={node.id}>
              <span className="workflow-run__node-status" data-status={node.status}>{nodeStatusLabel(node.status)}</span>
              <div className="workflow-run__node-copy">
                <strong>{node.employeeName}</strong>
                <small>{node.nodeType} · 尝试 {node.attemptCount}/{node.maxAttempts} · {durationLabel(node.startedAt, node.finishedAt)}</small>
              </div>
              <span>{node.artifactCount} 个产物{node.costUsd !== undefined ? ` · $${node.costUsd.toFixed(4)}` : ""}</span>
              {node.status === "failed" && node.attemptCount < node.maxAttempts ? (
                <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("retry_node", node.nodeId)} type="button">重试步骤</button>
              ) : <span>{node.errorCode ? errorCodeLabel(node.errorCode) : ""}</span>}
            </li>
          ))}
        </ol>
      </section>

      <WorkflowRunTimeline events={events} />
    </main>
  );
}

export function mergeWorkflowRunEvents(
  current: WorkflowRunEventItem[],
  incoming: WorkflowRunEventItem[],
): { events: WorkflowRunEventItem[]; gapAfter?: number } {
  const sorted = [...incoming].sort((left, right) => left.sequence - right.sequence);
  const previous = lastSequence(current);
  const next = sorted.filter((event) => event.sequence > previous);
  if (next.length > 0 && next[0]!.sequence > previous + 1) return { events: current, gapAfter: previous };
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of next) bySequence.set(event.sequence, event);
  return { events: [...bySequence.values()].sort((left, right) => left.sequence - right.sequence) };
}

function lastSequence(events: WorkflowRunEventItem[]): number {
  return events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
}

function runStatusLabel(status: string): string {
  const labels: Record<string, string> = { created: "已创建", queued: "排队中", running: "运行中", waiting_approval: "等待审批", paused: "已暂停", succeeded: "已完成", partially_succeeded: "部分完成", failed: "失败", cancelled: "已取消" };
  return labels[status] ?? "状态未知";
}

function nodeStatusLabel(status: string): string {
  const labels: Record<string, string> = { pending: "等待", ready: "就绪", queued: "排队", running: "执行中", waiting_approval: "待审批", retry_wait: "待重试", succeeded: "成功", failed: "失败", skipped: "已跳过", cancelled: "已取消" };
  return labels[status] ?? "未知";
}

function triggerLabel(type: string): string {
  return type === "schedule" ? "定时触发" : type === "event" ? "事件触发" : "手动触发";
}

function durationLabel(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "尚未开始";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const duration = Math.max(0, end - Date.parse(startedAt));
  if (!Number.isFinite(duration)) return "耗时未知";
  return duration < 60_000 ? `${Math.round(duration / 1000)} 秒` : `${Math.round(duration / 60_000)} 分钟`;
}

function errorCodeLabel(code: string): string {
  const labels: Record<string, string> = { workflow_node_retry_exhausted: "已达到重试上限", workflow_employee_not_ready: "AI 员工未就绪", workflow_node_execution_failed: "步骤执行失败" };
  return labels[code] ?? "执行未完成";
}
