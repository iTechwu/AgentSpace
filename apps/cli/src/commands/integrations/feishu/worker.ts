// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  type FeishuWebSocketWorkerMetrics
} from "@dofe-agent/services";
import type { FeishuWorkerHarnessSummary } from "./types.ts";

export function getFeishuWorkerExitCode(metrics: Pick<
  FeishuWebSocketWorkerMetrics,
  "connectionErrorCount" | "failedCount" | "processedCount"
>): number {
  if (metrics.processedCount > 0) {
    return 0;
  }
  return metrics.failedCount > 0 || metrics.connectionErrorCount > 0 ? 1 : 0;
}
export function buildFeishuWorkerHarnessSummary(input: {
  workspaceId: string;
  integrationId?: string;
}): FeishuWorkerHarnessSummary {
  const systemdUnitPath = "deploy/systemd/dofe-agent-feishu-worker.service";
  const systemdEnvExamplePath = "deploy/systemd/dofe-agent-feishu-worker.env.example";
  const dockerComposePath = "deploy/feishu-worker/docker-compose.yml";
  const dockerEnvExamplePath = "deploy/feishu-worker/feishu-worker.env.example";
  const integrationFlag = input.integrationId ? ` --integration ${input.integrationId}` : "";
  return {
    ...(input.integrationId ? { integrationId: input.integrationId } : {}),
    systemdUnitPath,
    systemdEnvExamplePath,
    dockerComposePath,
    dockerEnvExamplePath,
    dryRunCommand:
      `dofe-agent integrations feishu worker --workspace-id ${input.workspaceId}${integrationFlag} --dry-run --json`,
    startCommand: `dofe-agent integrations feishu worker --workspace-id ${input.workspaceId}${integrationFlag} --json`,
    systemdRestartCommand: "sudo systemctl restart dofe-agent-feishu-worker && sudo systemctl status dofe-agent-feishu-worker --no-pager",
    dockerRestartCommand: `docker compose -f ${dockerComposePath} restart feishu-worker && docker compose -f ${dockerComposePath} logs --tail=100 feishu-worker`,
  };
}
export function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
