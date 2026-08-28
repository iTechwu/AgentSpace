"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { translateWorkflowErrorCode } from "@/features/i18n/presentation";
import { runWorkflowAction } from "./workflow-actions";

/**
 * 「立即运行」控制逻辑（任务看板与工作流列表共用）。
 *
 * 两处入口此前各自重复实现「二次确认 → 调用 runWorkflowAction → 成功跳转运行详情 /
 * 失败展示错误码」的逻辑；这里抽出为单一 hook，保证错误展示、幂等键前缀与跳转路径一致，
 * 避免后续维护时一处修了另一处遗漏。
 */
export interface UseManualWorkflowRunResult {
  running: boolean;
  notice?: string;
  run: (workflowId: string) => Promise<void>;
}

export function useManualWorkflowRun(
  workspaceSlug: string,
  tx: (zh: string, en: string) => string,
  /** 幂等键前缀，区分调用来源（看板 / 列表），便于排查重复触发。 */
  idempotencyPrefix: "taskboard" | "list",
): UseManualWorkflowRunResult {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  async function run(workflowId: string): Promise<void> {
    if (!workflowId || running) return;
    if (!window.confirm(tx("确认立即运行该工作流？", "Run this workflow now?"))) return;
    setRunning(true);
    setNotice(undefined);
    try {
      const result = await runWorkflowAction({
        workflowId,
        idempotencyKey: `${idempotencyPrefix}-${workflowId}-${Date.now()}`,
        input: {},
      });
      if (!result.ok) {
        setNotice(translateWorkflowErrorCode(result.error.code, tx));
        return;
      }
      router.push(buildWorkspacePath(workspaceSlug, `/automations/runs/${result.data.runId}`));
    } catch {
      setNotice(tx("立即运行未完成，请稍后重试。", "Manual run failed, please retry."));
    } finally {
      setRunning(false);
    }
  }

  return { running, notice, run };
}
