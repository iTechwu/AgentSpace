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
    <section className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <Link
            href={buildWorkspacePath(workspaceSlug, "/runtimes")}
            className="text-xs text-neutral-500 hover:underline"
          >
            ← Runtimes
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{task.runtimeType} provisioning</h1>
          <p className="font-mono text-xs text-neutral-400">{task.id}</p>
        </div>
        <div className="flex gap-2">
          {(task.status === "failed" || task.status === "retrying") &&
          task.retryCount < task.maxRetries ? (
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs disabled:opacity-50"
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
              className="rounded border px-2 py-1 text-xs disabled:opacity-50"
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

      <div className="rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
          <span>requested: {new Date(task.createdAt).toLocaleString()}</span>
          <span>elapsed: {formatElapsed(task.startedAt ?? task.createdAt, task.completedAt, clock)}</span>
          <span>safe cancellation: {task.runtimeCredentialId ? "cleanup required" : "yes"}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{task.stage}</span>
          <span>{task.progressPercent}%</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full bg-neutral-900 dark:bg-white"
            style={{ width: `${task.progressPercent}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
          <span>status: {task.status}</span>
          {task.runtimeCredentialId ? (
            <span>credential: {task.runtimeCredentialId.slice(0, 12)}…</span>
          ) : null}
          {task.nextRetryAt ? (
            <span>next retry: {new Date(task.nextRetryAt).toLocaleString()}</span>
          ) : null}
          {task.retryCount > 0 ? <span>retries: {task.retryCount}</span> : null}
          {task.lastErrorMessage ? (
            <span className="text-red-600">error: {task.lastErrorMessage}</span>
          ) : null}
        </div>
      </div>

      {runtime ? (
        <div className="rounded-lg border p-4 text-sm">
          <h2 className="mb-2 font-medium">Managed runtime</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-neutral-500">Runtime ID</dt>
            <dd className="font-mono">{runtime.id}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd>{runtime.status}</dd>
            <dt className="text-neutral-500">Provisioning state</dt>
            <dd>{runtime.provisioningState ?? "—"}</dd>
            <dt className="text-neutral-500">Protocols</dt>
            <dd>{(runtime.protocols ?? []).join(", ") || "—"}</dd>
            <dt className="text-neutral-500">Default model</dt>
            <dd>{runtime.defaultModel ?? "—"}</dd>
          </dl>
        </div>
      ) : null}

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">Stage log</h2>
        {events.length === 0 ? (
          <p className="text-xs text-neutral-500">No events yet.</p>
        ) : (
          <ol className="space-y-1 text-xs">
            {events.map((event) => (
              <li key={event.id} className="flex gap-2">
                <span className="font-mono text-neutral-400">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
                <span className="font-medium">{event.stage}</span>
                <span className="text-neutral-500">{event.status}</span>
                {event.summary ? <span className="text-neutral-600">{event.summary}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function formatElapsed(start: string, completedAt: string | undefined, now: number): string {
  const durationSeconds = Math.max(0, Math.floor(((completedAt ? new Date(completedAt).getTime() : now) - new Date(start).getTime()) / 1000));
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
