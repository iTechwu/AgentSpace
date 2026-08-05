"use client";

import { useState } from "react";
import type {
  OpenMontageJobProjection,
  OpenMontageJobStatus,
  OpenMontageStageProjection,
} from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";

export type OpenMontageJobAction = {
  action: "approve" | "reject" | "cancel";
  jobId: string;
  stage?: string;
  expectedSequence: number;
};

export function OpenMontageJobCard({
  job,
  onAction,
}: {
  job: OpenMontageJobProjection;
  onAction?: (action: OpenMontageJobAction) => Promise<void>;
}) {
  const { language, tx } = useLanguage();
  const [pendingAction, setPendingAction] = useState<OpenMontageJobAction["action"] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const currentStage = job.stages.find((stage) => stage.code === job.currentStage) ?? null;
  const status = job.syncStatus === "SYNCING"
    ? { label: tx("正在同步最新进度", "Syncing latest progress"), tone: "syncing" }
    : jobStatusPresentation(job.status, tx);
  const usage = readUsageSummary(job.usageSummary, language);

  async function runAction(action: OpenMontageJobAction["action"]): Promise<void> {
    if (!onAction || pendingAction) {
      return;
    }
    const stage = action === "approve" || action === "reject" ? currentStage?.code : undefined;
    setPendingAction(action);
    setActionError(null);
    try {
      await onAction({
        action,
        jobId: job.jobId,
        stage,
        expectedSequence: job.lastAppliedSequence,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx("操作提交失败，请重试。", "Action failed. Please try again."));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <article
      aria-label={tx(`视频任务：${job.workflow.name}`, `Video job: ${job.workflow.name}`)}
      className={`openmontage-job-card openmontage-job-card--${status.tone}`}
    >
      <header className="openmontage-job-card__header">
        <div className="openmontage-job-card__identity">
          <span className="openmontage-job-card__icon"><AppIcon name="scissors" /></span>
          <div>
            <h3>{tx("视频任务", "Video job")}</h3>
            <p>{formatWorkflowName(job.workflow.name)}</p>
          </div>
        </div>
        <span aria-live="polite" className="openmontage-job-card__status">
          {status.tone === "running" || status.tone === "syncing" ? <AppIcon name="loader" /> : null}
          {status.tone === "success" ? <AppIcon name="checkCircle" /> : null}
          {status.tone === "danger" || status.tone === "warning" ? <AppIcon name="alertCircle" /> : null}
          {status.label}
        </span>
      </header>

      {currentStage ? (
        <p className="openmontage-job-card__current">
          <span>{tx("当前阶段", "Current stage")}</span>
          <strong>{stageLabel(currentStage, tx)}</strong>
          {currentStage.progress ? (
            <em>{currentStage.progress.completedUnits} / {currentStage.progress.totalUnits}</em>
          ) : null}
        </p>
      ) : null}

      <ol aria-label={tx("视频制作阶段", "Video production stages")} className="openmontage-stage-list">
        {job.stages.map((stage) => (
          <li className={`openmontage-stage openmontage-stage--${stage.status.toLowerCase()}`} key={stage.code}>
            <span className="openmontage-stage__marker">
              {stage.status === "SUCCEEDED" ? <AppIcon name="checkCircle" /> : null}
              {stage.status === "RUNNING" ? <AppIcon name="loader" /> : null}
              {stage.status === "FAILED" || stage.status === "WAITING_APPROVAL" ? <AppIcon name="alertCircle" /> : null}
            </span>
            <div className="openmontage-stage__body">
              <div className="openmontage-stage__heading">
                <strong>{stageLabel(stage, tx)}</strong>
                <span>{stageStatusLabel(stage.status, tx)}</span>
              </div>
              <div className="openmontage-stage__progress-slot">
                {stage.progress ? (
                  <>
                    <div
                      aria-label={tx(`${stageLabel(stage, tx)}进度`, `${stageLabel(stage, tx)} progress`)}
                      aria-valuemax={stage.progress.totalUnits}
                      aria-valuemin={0}
                      aria-valuenow={stage.progress.completedUnits}
                      className="openmontage-stage__progress"
                      role="progressbar"
                    >
                      <span style={{ width: `${Math.min(100, (stage.progress.completedUnits / stage.progress.totalUnits) * 100)}%` }} />
                    </div>
                    <span>{stage.progress.completedUnits} / {stage.progress.totalUnits}</span>
                  </>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {job.status === "WAITING_APPROVAL" && currentStage ? (
        <div className="openmontage-job-card__notice" role="status">
          <AppIcon name="approvals" />
          <span>{tx(`“${stageLabel(currentStage, tx)}”需要你的决定后才能继续。`, `“${stageLabel(currentStage, tx)}” needs your decision before it can continue.`)}</span>
        </div>
      ) : null}

      {actionError ? <p className="openmontage-job-card__error" role="alert">{actionError}</p> : null}

      <div className="openmontage-job-card__actions">
        {job.status === "WAITING_APPROVAL" && currentStage ? (
          <>
            <button disabled={!onAction || Boolean(pendingAction)} onClick={() => void runAction("approve")} type="button">
              <AppIcon name={pendingAction === "approve" ? "loader" : "checkCircle"} />
              {pendingAction === "approve" ? tx("提交中", "Submitting") : tx("批准并继续", "Approve and continue")}
            </button>
            <button disabled={!onAction || Boolean(pendingAction)} onClick={() => void runAction("reject")} type="button">
              <AppIcon name={pendingAction === "reject" ? "loader" : "close"} />
              {pendingAction === "reject" ? tx("提交中", "Submitting") : tx("驳回", "Reject")}
            </button>
          </>
        ) : null}
        {(job.status === "QUEUED" || job.status === "RUNNING") ? (
          <button disabled={!onAction || Boolean(pendingAction)} onClick={() => void runAction("cancel")} type="button">
            <AppIcon name={pendingAction === "cancel" ? "loader" : "stop"} />
            {pendingAction === "cancel" ? tx("正在提交", "Submitting") : tx("取消任务", "Cancel job")}
          </button>
        ) : null}
      </div>

      <details className="openmontage-job-card__details">
        <summary>
          <span>{tx("任务详情", "Job details")}</span>
          <AppIcon name="chevronDown" />
        </summary>
        <div className="openmontage-job-card__detail-grid">
          <section>
            <h4>{tx("费用与用量", "Cost and usage")}</h4>
            {usage ? (
              <dl>
                <div><dt>{tx("模型实际消费", "Actual model cost")}</dt><dd>{usage.amount}</dd></div>
                {usage.status ? <div><dt>{tx("对账状态", "Reconciliation")}</dt><dd>{usage.status}</dd></div> : null}
              </dl>
            ) : <p>{tx("实际费用对账中", "Actual cost reconciliation pending")}</p>}
          </section>
          <section>
            <h4>{tx("产物", "Artifacts")}</h4>
            {job.artifacts.length > 0 ? (
              <ul>
                {job.artifacts.map((artifact, index) => (
                  <li key={readText(artifact.artifactId) ?? `${job.jobId}-artifact-${index}`}>
                    <AppIcon name="fileText" />
                    <span>{readText(artifact.name) ?? readText(artifact.label) ?? tx("视频产物", "Video artifact")}</span>
                    <em>{artifactStatusLabel(readText(artifact.status), tx)}</em>
                  </li>
                ))}
              </ul>
            ) : <p>{tx("尚无可用产物", "No artifacts available yet")}</p>}
          </section>
        </div>
        {job.error ? (
          <p className="openmontage-job-card__failure">
            <strong>{tx("失败原因", "Failure reason")}</strong>
            <span>{readText(job.error.message) ?? tx("视频处理失败，请稍后重试。", "Video processing failed. Please try again later.")}</span>
          </p>
        ) : null}
        <p className="openmontage-job-card__updated">
          {tx("更新于", "Updated")} {formatTimestamp(job.updatedAt, language)}
        </p>
      </details>
    </article>
  );
}

function jobStatusPresentation(
  status: OpenMontageJobStatus,
  tx: (zh: string, en: string) => string,
): { label: string; tone: string } {
  switch (status) {
    case "QUEUED": return { label: tx("等待处理", "Queued"), tone: "neutral" };
    case "RUNNING": return { label: tx("制作中", "In production"), tone: "running" };
    case "WAITING_APPROVAL": return { label: tx("等待审批", "Waiting for approval"), tone: "warning" };
    case "SUCCEEDED": return { label: tx("已完成", "Completed"), tone: "success" };
    case "FAILED": return { label: tx("处理失败", "Failed"), tone: "danger" };
    case "CANCEL_REQUESTED": return { label: tx("正在停止", "Stopping"), tone: "warning" };
    case "CANCELLED": return { label: tx("已停止", "Cancelled"), tone: "neutral" };
  }
}

function stageStatusLabel(
  status: OpenMontageStageProjection["status"],
  tx: (zh: string, en: string) => string,
): string {
  switch (status) {
    case "PENDING": return tx("待处理", "Pending");
    case "RUNNING": return tx("进行中", "In progress");
    case "WAITING_APPROVAL": return tx("等待审批", "Waiting for approval");
    case "SUCCEEDED": return tx("已完成", "Completed");
    case "FAILED": return tx("失败", "Failed");
    case "CANCELLED": return tx("已停止", "Cancelled");
    case "SKIPPED": return tx("已跳过", "Skipped");
  }
}

function stageLabel(stage: OpenMontageStageProjection, tx: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    research: ["研究素材", "Research"],
    idea: ["构思创意", "Concept"],
    proposal: ["生成制作方案", "Production proposal"],
    script: ["编写脚本", "Script"],
    scene: ["规划场景", "Scene planning"],
    scene_plan: ["规划场景", "Scene planning"],
    asset: ["生成素材", "Asset generation"],
    assets: ["生成素材", "Asset generation"],
    edit: ["剪辑视频", "Edit"],
    compose: ["合成视频", "Composition"],
    publish: ["发布视频", "Publish"],
    character_design: ["角色设计", "Character design"],
    rig_plan: ["角色绑定规划", "Rig planning"],
  };
  const known = labels[stage.code] ?? labels[stage.labelCode.replace("openmontage.stage.", "")];
  return known ? tx(known[0], known[1]) : formatWorkflowName(stage.code);
}

function readUsageSummary(
  summary: Record<string, unknown> | undefined,
  language: "zh" | "en",
): { amount: string; status?: string } | null {
  if (!summary) return null;
  const rawAmount = [summary.actualAmount, summary.actualCost, summary.totalAmount].find((value) => typeof value === "number");
  if (typeof rawAmount !== "number") return null;
  const currency = readText(summary.currency) ?? "CNY";
  let amount: string;
  try {
    amount = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(rawAmount);
  } catch {
    amount = `${currency} ${rawAmount.toFixed(2)}`;
  }
  const rawStatus = readText(summary.reconciliationStatus);
  return {
    amount,
    status: rawStatus === "RECONCILED"
      ? (language === "zh" ? "已对账" : "Reconciled")
      : rawStatus === "PENDING"
        ? (language === "zh" ? "对账中" : "Pending")
        : undefined,
  };
}

function artifactStatusLabel(status: string | undefined, tx: (zh: string, en: string) => string): string {
  if (status === "READY" || status === "PUBLISHED") return tx("可用", "Ready");
  if (status === "FAILED") return tx("准备失败", "Failed");
  return tx("准备中", "Preparing");
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatWorkflowName(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string, language: "zh" | "en"): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}
