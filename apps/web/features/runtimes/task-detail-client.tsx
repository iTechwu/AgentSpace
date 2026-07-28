"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  cancelProvisioningAction,
  getProvisioningTaskAction,
  retryProvisioningAction,
} from "@/features/runtimes/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import type { RuntimeProvisioningTaskDetail } from "@dofe-agent/services";

const POLL_INTERVAL_MS = 2000;

export function RuntimeTaskDetailClient({
  workspaceSlug,
  initialDetail,
}: {
  workspaceSlug: string;
  initialDetail: RuntimeProvisioningTaskDetail;
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [pending, startTransition] = useTransition();
  const [clock, setClock] = useState(() => Date.now());
  const stopRef = useRef(false);

  const isTerminal =
    detail.task.status === "succeeded" ||
    detail.task.status === "failed" ||
    detail.task.status === "cancelled";

  useEffect(() => {
    if (isTerminal) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isTerminal]);

  useEffect(() => {
    if (isTerminal) return;
    stopRef.current = false;
    const poll = async () => {
      while (!stopRef.current) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (stopRef.current) break;
        try {
          const next = await getProvisioningTaskAction(detail.task.id);
          setDetail(next);
          if (
            next.task.status === "succeeded" ||
            next.task.status === "failed" ||
            next.task.status === "cancelled"
          ) {
            break;
          }
        } catch {
          break;
        }
      }
    };
    void poll();
    return () => {
      stopRef.current = true;
    };
  }, [detail.task.id, detail.task.status, isTerminal]);

  const { task, events, runtime } = detail;

  return (
    <section className="page-shell runtimes-page runtime-task-detail">
      <header className="runtime-task-detail__header">
        <div className="runtime-task-detail__heading">
          <Link
            href={buildWorkspacePath(workspaceSlug, "/runtimes")}
            className="runtime-task-detail__back-link"
          >
            ← Runtimes
          </Link>
          <h1>{task.runtimeType} provisioning</h1>
          <p>{task.id}</p>
        </div>
        <div className="runtime-task-detail__actions">
          {(task.status === "failed" || task.status === "retrying") &&
          task.retryCount < task.maxRetries ? (
            <button
              type="button"
              className="action-button runtime-action-button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await retryProvisioningAction(task.id);
                })
              }
            >
              Retry (retry {task.retryCount + 1}/{task.maxRetries})
            </button>
          ) : null}
          {task.status === "running" || task.status === "queued" || task.status === "retrying" || task.status === "failed" ? (
            <button
              type="button"
              className="action-button runtime-action-button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await cancelProvisioningAction(task.id, "ui_cancel");
                })
              }
            >
              Cancel
            </button>
          ) : null}
        </div>
      </header>

      <section className="runtime-task-detail__progress" aria-label="Provisioning progress">
        <div className="runtime-task-detail__meta">
          <span>requested: {new Date(task.createdAt).toLocaleString()}</span>
          <span>elapsed: {formatElapsed(task.startedAt ?? task.createdAt, task.completedAt, clock)}</span>
          <span>safe cancellation: {task.runtimeCredentialId ? "cleanup required" : "yes"}</span>
        </div>
        <div className="runtime-task-detail__stage">
          <span>{task.stage}</span>
          <span>{task.progressPercent}%</span>
        </div>
        <div className="runtime-task-detail__progress-track" aria-hidden="true">
          <div
            className="runtime-task-detail__progress-bar"
            style={{ width: `${task.progressPercent}%` }}
          />
        </div>
        <div className="runtime-task-detail__meta runtime-task-detail__meta--status">
          <span>status: {task.status}</span>
          {task.runtimeCredentialId ? (
            <span>credential: {task.runtimeCredentialId.slice(0, 12)}…</span>
          ) : null}
          {task.nextRetryAt ? (
            <span>next retry: {new Date(task.nextRetryAt).toLocaleString()}</span>
          ) : null}
          {task.retryCount > 0 ? <span>retries: {task.retryCount}</span> : null}
          {task.lastErrorMessage ? (
            <span className="runtime-task-detail__error">error: {task.lastErrorMessage}</span>
          ) : null}
        </div>
      </section>

      {runtime ? (
        <section className="runtimes-panel runtime-task-detail__panel">
          <div className="runtimes-panel__header">
            <div>
              <span>Resource</span>
              <h2>Managed runtime</h2>
            </div>
          </div>
          <dl className="runtime-task-detail__runtime-fields">
            <dt>Runtime ID</dt>
            <dd>{runtime.id}</dd>
            <dt>Status</dt>
            <dd>{runtime.status}</dd>
            <dt>Provisioning state</dt>
            <dd>{runtime.provisioningState ?? "—"}</dd>
            <dt>Protocols</dt>
            <dd>{(runtime.protocols ?? []).join(", ") || "—"}</dd>
            <dt>Default model</dt>
            <dd>{runtime.defaultModel ?? "—"}</dd>
          </dl>
        </section>
      ) : null}

      <section className="runtimes-panel runtime-task-detail__panel">
        <div className="runtimes-panel__header">
          <div>
            <span>Activity</span>
            <h2>Stage log</h2>
          </div>
        </div>
        {events.length === 0 ? (
          <p className="runtime-task-detail__empty-events">No events yet.</p>
        ) : (
          <ol className="runtime-task-detail__events">
            {events.map((event) => (
              <li key={event.id}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString()}
                </time>
                <strong>{event.stage}</strong>
                <span>{event.status}</span>
                {event.summary ? <span className="runtime-task-detail__event-summary">{event.summary}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function formatElapsed(start: string, completedAt: string | undefined, now: number): string {
  const durationSeconds = Math.max(0, Math.floor(((completedAt ? new Date(completedAt).getTime() : now) - new Date(start).getTime()) / 1000));
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
