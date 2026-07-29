"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  cancelProvisioningAction,
  getProvisioningTaskAction,
  retryProvisioningAction,
} from "@/features/runtimes/actions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { useLanguage } from "@/features/i18n/language-provider";
import type { TxFn } from "@/features/i18n/presentation";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { RuntimeProvisioningTaskDetail } from "@dofe-agent/services";

const POLL_INTERVAL_MS = 2000;

export function RuntimeTaskDetailClient({
  workspaceSlug,
  initialDetail,
}: {
  workspaceSlug: string;
  initialDetail: RuntimeProvisioningTaskDetail;
}) {
  const { language, tx } = useLanguage();
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
            {tx("← 执行引擎", "← Runtimes")}
          </Link>
          <h1>{tx(`${formatDaemonProviderLabel(task.runtimeType)} 部署`, `${formatDaemonProviderLabel(task.runtimeType)} provisioning`)}</h1>
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
              {tx(`重试（第 ${task.retryCount + 1}/${task.maxRetries} 次）`, `Retry (retry ${task.retryCount + 1}/${task.maxRetries})`)}
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
              {tx("取消", "Cancel")}
            </button>
          ) : null}
        </div>
      </header>

      <section className="runtime-task-detail__progress" aria-label={tx("部署进度", "Provisioning progress")}>
        <div className="runtime-task-detail__meta">
          <span>{tx("发起时间：", "requested: ")}{formatDateTime(task.createdAt, language)}</span>
          <span>{tx("耗时：", "elapsed: ")}{formatElapsed(task.startedAt ?? task.createdAt, task.completedAt, clock)}</span>
          <span>{tx("安全取消：", "safe cancellation: ")}{task.runtimeCredentialId ? tx("需要清理", "cleanup required") : tx("可以", "yes")}</span>
        </div>
        <div className="runtime-task-detail__stage">
          <span>{translateProvisioningStage(task.stage, tx)}</span>
          <span>{task.progressPercent}%</span>
        </div>
        <div className="runtime-task-detail__progress-track" aria-hidden="true">
          <div
            className="runtime-task-detail__progress-bar"
            style={{ width: `${task.progressPercent}%` }}
          />
        </div>
        <div className="runtime-task-detail__meta runtime-task-detail__meta--status">
          <span>{tx("状态：", "status: ")}{translateProvisioningStatus(task.status, tx)}</span>
          {task.runtimeCredentialId ? (
            <span>{tx("凭证：", "credential: ")}{task.runtimeCredentialId.slice(0, 12)}…</span>
          ) : null}
          {task.nextRetryAt ? (
            <span>{tx("下次重试：", "next retry: ")}{formatDateTime(task.nextRetryAt, language)}</span>
          ) : null}
          {task.retryCount > 0 ? <span>{tx("已重试：", "retries: ")}{task.retryCount}</span> : null}
          {task.lastErrorMessage ? (
            <span className="runtime-task-detail__error">{tx("错误：", "error: ")}{task.lastErrorMessage}</span>
          ) : null}
        </div>
      </section>

      {runtime ? (
        <section className="runtimes-panel runtime-task-detail__panel">
          <div className="runtimes-panel__header">
            <div>
              <span>{tx("资源", "Resource")}</span>
              <h2>{tx("托管执行引擎", "Managed runtime")}</h2>
            </div>
          </div>
          <dl className="runtime-task-detail__runtime-fields">
            <dt>{tx("执行引擎 ID", "Runtime ID")}</dt>
            <dd>{runtime.id}</dd>
            <dt>{tx("状态", "Status")}</dt>
            <dd>{translateRuntimeStatus(runtime.status, tx)}</dd>
            <dt>{tx("部署状态", "Provisioning state")}</dt>
            <dd>{translateProvisioningState(runtime.provisioningState, tx)}</dd>
            <dt>{tx("协议", "Protocols")}</dt>
            <dd>{(runtime.protocols ?? []).join(", ") || "—"}</dd>
            <dt>{tx("默认模型", "Default model")}</dt>
            <dd>{runtime.defaultModel ?? "—"}</dd>
          </dl>
        </section>
      ) : null}

      <section className="runtimes-panel runtime-task-detail__panel">
        <div className="runtimes-panel__header">
          <div>
            <span>{tx("活动", "Activity")}</span>
            <h2>{tx("阶段日志", "Stage log")}</h2>
          </div>
        </div>
        {events.length === 0 ? (
          <p className="runtime-task-detail__empty-events">{tx("暂无事件。", "No events yet.")}</p>
        ) : (
          <ol className="runtime-task-detail__events">
            {events.map((event) => (
              <li key={event.id}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US")}
                </time>
                <strong>{translateProvisioningStage(event.stage, tx)}</strong>
                <span>{translateProvisioningStatus(event.status, tx)}</span>
                {event.summary ? <span className="runtime-task-detail__event-summary">{event.summary}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function translateProvisioningStage(value: string, tx: TxFn): string {
  const labels: Record<string, [string, string]> = {
    pending: ["等待处理", "Pending"],
    request_credential: ["申请凭证", "Request credential"],
    prepare_node: ["准备节点", "Prepare node"],
    pull_image: ["拉取镜像", "Pull image"],
    install_cli: ["安装 CLI", "Install CLI"],
    write_credential: ["写入凭证", "Write credential"],
    health_check: ["健康检查", "Health check"],
    cleanup: ["清理资源", "Cleanup"],
    ready: ["准备就绪", "Ready"],
  };
  const label = labels[value];
  return label ? tx(...label) : value;
}

function translateProvisioningStatus(value: string, tx: TxFn): string {
  const labels: Record<string, [string, string]> = {
    pending: ["等待中", "Pending"],
    queued: ["已排队", "Queued"],
    running: ["进行中", "Running"],
    retrying: ["重试中", "Retrying"],
    succeeded: ["已完成", "Succeeded"],
    failed: ["失败", "Failed"],
    cancelling: ["取消中", "Cancelling"],
    cancelled: ["已取消", "Cancelled"],
    skipped: ["已跳过", "Skipped"],
  };
  const label = labels[value];
  return label ? tx(...label) : value;
}

function translateRuntimeStatus(value: string, tx: TxFn): string {
  if (value === "online") return tx("在线", "Online");
  if (value === "offline") return tx("离线", "Offline");
  return translateProvisioningStatus(value, tx);
}

function translateProvisioningState(value: string | null | undefined, tx: TxFn): string {
  if (!value) return "—";
  if (value === "managed") return tx("托管", "Managed");
  return translateProvisioningStatus(value, tx);
}

function formatDateTime(value: string, language: "zh" | "en"): string {
  return new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US");
}

function formatElapsed(start: string, completedAt: string | undefined, now: number): string {
  const durationSeconds = Math.max(0, Math.floor(((completedAt ? new Date(completedAt).getTime() : now) - new Date(start).getTime()) / 1000));
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
