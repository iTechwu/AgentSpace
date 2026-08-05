"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpenMontageJobProjection } from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";
import {
  OpenMontageJobCard,
  type OpenMontageJobAction,
} from "@/features/channels/openmontage-job-card";
import { AppIcon } from "@/shared/ui/app-icon";

export function OpenMontageChannelJobs({
  workspaceId,
  channelName,
  refreshVersion,
  onPresenceChange,
}: {
  workspaceId: string;
  channelName: string;
  refreshVersion: number;
  onPresenceChange?: (hasJobs: boolean) => void;
}) {
  const { tx } = useLanguage();
  const [jobs, setJobs] = useState<OpenMontageJobProjection[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    onPresenceChange?.(jobs.length > 0);
  }, [jobs.length, onPresenceChange]);

  const loadJobs = useCallback(async (signal: AbortSignal): Promise<void> => {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelName)}/openmontage/jobs`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(`OpenMontage projection request returned HTTP ${response.status}.`);
    }
    const body = await response.json() as unknown;
    const nextJobs = parseProjectionList(body);
    setJobs((current) => current.length === 0 && nextJobs.length === 0 ? current : nextJobs);
    setLoadError(false);
  }, [channelName, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal).catch((error) => {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        setLoadError(true);
      }
    });
    return () => controller.abort();
  }, [loadJobs, refreshVersion, retryVersion]);

  async function submitAction(action: OpenMontageJobAction): Promise<void> {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/openmontage/jobs/${encodeURIComponent(action.jobId)}/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action.action,
          ...(action.stage ? { stage: action.stage } : {}),
          expectedSequence: action.expectedSequence,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(await readActionError(response, tx));
    }
    await loadJobs(AbortSignal.timeout(10_000));
  }

  if (jobs.length === 0 && !loadError) {
    return null;
  }

  return (
    <>
      {jobs.map((job) => (
        <OpenMontageJobCard job={job} key={job.jobId} onAction={submitAction} workspaceId={workspaceId} />
      ))}
      {loadError ? (
        <div className="openmontage-channel-jobs__error" role="alert">
          <AppIcon name="alertCircle" />
          <span>{tx("视频任务状态暂时无法更新，已保留最后可信进度。", "Video job status could not be updated. The last trusted progress is retained.")}</span>
          <button aria-label={tx("重试更新视频任务", "Retry video job update")} onClick={() => setRetryVersion((value) => value + 1)} type="button">
            <AppIcon name="refresh" />
          </button>
        </div>
      ) : null}
    </>
  );
}

function parseProjectionList(value: unknown): OpenMontageJobProjection[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenMontage projection response is invalid.");
  }
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs) || jobs.some((job) => !isProjection(job))) {
    throw new Error("OpenMontage projection response is invalid.");
  }
  return jobs as OpenMontageJobProjection[];
}

function isProjection(value: unknown): value is OpenMontageJobProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const source = value as Record<string, unknown>;
  return source.schemaVersion === 1
    && typeof source.jobId === "string"
    && typeof source.status === "string"
    && Boolean(source.workflow)
    && Array.isArray(source.stages)
    && typeof source.lastAppliedSequence === "number"
    && (source.syncStatus === "CURRENT" || source.syncStatus === "SYNCING");
}

async function readActionError(
  response: Response,
  tx: (zh: string, en: string) => string,
): Promise<string> {
  let code = "";
  try {
    const body = await response.json() as { error?: unknown };
    code = typeof body.error === "string" ? body.error : "";
  } catch {
    // Fall through to a stable user-facing message.
  }
  switch (code) {
    case "openmontage_job_changed":
      return tx("任务状态已经变化，请确认最新进度后重试。", "The job changed. Review the latest progress and try again.");
    case "openmontage_job_action_conflict":
      return tx("这个操作已经不可用，正在等待最新状态。", "This action is no longer available. Waiting for the latest status.");
    case "openmontage_unavailable":
      return tx("视频服务尚未配置完成。", "The video service is not configured.");
    default:
      return tx("视频服务未能接受操作，请稍后重试。", "The video service could not accept the action. Please try again.");
  }
}
