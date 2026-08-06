"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  translateWorkflowErrorCode,
  translateWorkflowNodeStatus,
  translateWorkflowRunStatus,
  translateWorkflowTriggerType,
} from "@/features/i18n/presentation";
import { useLanguage } from "@/features/i18n/language-provider";
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
  const { tx } = useLanguage();
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
      setNotice(translateWorkflowErrorCode("workflow_run_events_unavailable", tx));
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
        setNotice(translateWorkflowErrorCode(result.error.code, tx));
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
          <p>运行 ID {projection.id} · {translateWorkflowTriggerType(projection.triggerType, tx)}</p>
        </div>
        <div className="workflow-run__header-state">
          <strong data-status={projection.status}>{translateWorkflowRunStatus(projection.status, tx)}</strong>
          <div className="workflow-run__controls">
            {canPause ? <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("pause")} type="button">暂停</button> : null}
            {canResume ? <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("resume")} type="button">恢复</button> : null}
            {canCancel ? <button className="knowledge-btn knowledge-btn--danger" disabled={Boolean(pendingControl)} onClick={() => void control("cancel")} type="button">取消</button> : null}
          </div>
        </div>
      </header>

      {isSyncing ? <p className="workflow-run__sync" role="status">{translateWorkflowErrorCode("workflow_event_sequence_gap", tx)}</p> : null}
      {notice ? <p className="workflow-run__notice" role="status">{notice}</p> : null}

      <section aria-labelledby="workflow-run-steps-title" className="workflow-run__steps">
        <header><h2 id="workflow-run-steps-title">执行步骤</h2><span>{projection.nodes.length} 个节点</span></header>
        <ol>
          {projection.nodes.map((node) => (
            <li key={node.id}>
              <span className="workflow-run__node-status" data-status={node.status}>{translateWorkflowNodeStatus(node.status, tx)}</span>
              <div className="workflow-run__node-copy">
                <strong>{node.employeeName}</strong>
                <small>{node.nodeType} · 尝试 {node.attemptCount}/{node.maxAttempts} · {durationLabel(node.startedAt, node.finishedAt)}</small>
              </div>
              <span>{node.artifactCount} 个产物{node.costUsd !== undefined ? ` · $${node.costUsd.toFixed(4)}` : ""}</span>
              {node.status === "failed" && projection.status === "failed" && node.nodeType === "employee_task" ? (
                <button className="knowledge-btn" disabled={Boolean(pendingControl)} onClick={() => void control("retry_node", node.nodeId)} type="button">重试步骤</button>
              ) : <span>{node.errorCode ? translateWorkflowErrorCode(node.errorCode, tx) : ""}</span>}
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

function durationLabel(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "尚未开始";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const duration = Math.max(0, end - Date.parse(startedAt));
  if (!Number.isFinite(duration)) return "耗时未知";
  return duration < 60_000 ? `${Math.round(duration / 1000)} 秒` : `${Math.round(duration / 60_000)} 分钟`;
}
