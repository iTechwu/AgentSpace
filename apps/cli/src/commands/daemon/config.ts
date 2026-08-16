// daemon CLI 的守护进程配置与 provider 探测（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { getStringFlag } from "../../lib/args.ts";
import { detectProviders as detectSharedProviders } from "dofe-agent-daemon";
import type { DetectedProvider as SharedDetectedProvider } from "dofe-agent-daemon";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_TASK_POLL_INTERVAL_MS = 3_000;
// 与 daemon 侧 state.ts 的 DEFAULT_OPERATION_CLAIM_INTERVAL_MS 保持一致。
export const DEFAULT_OPERATION_CLAIM_INTERVAL_MS = 15_000;
export const DEFAULT_OFFLINE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_LINES = 50;
export interface DaemonConfig {
  mode: "local" | "remote";
  daemonKey: string;
  deviceName: string;
  runtimeName: string;
  workspaceId?: string;
  heartbeatIntervalMs: number;
  taskPollIntervalMs: number;
  operationClaimIntervalMs: number;
  taskTimeoutMs: number;
  manageFeishuWorker: boolean;
  serverUrl?: string;
  daemonToken?: string;
}
export type DetectedProvider = SharedDetectedProvider;
export function buildDaemonConfig(flags: Record<string, string | boolean>): DaemonConfig {
  const hostname = process.env.HOSTNAME || process.env.COMPUTERNAME || "local-machine";
  const mode = getStringFlag(flags, "mode")?.trim() === "remote" ? "remote" : "local";
  return {
    mode,
    daemonKey: getStringFlag(flags, "daemon-id")?.trim() || hostname,
    deviceName: getStringFlag(flags, "device-name")?.trim() || hostname,
    runtimeName: getStringFlag(flags, "runtime-name")?.trim() || "Local Agent",
    workspaceId: getStringFlag(flags, "workspace-id")?.trim() || process.env.DOFE_AGENT_WORKSPACE_ID?.trim() || undefined,
    heartbeatIntervalMs: Math.max(
      1_000,
      Number(getStringFlag(flags, "heartbeat-interval") ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    ),
    taskPollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS,
    operationClaimIntervalMs: Math.max(
      1_000,
      Number(
        process.env.DOFE_AGENT_OPERATION_CLAIM_INTERVAL
          ?? DEFAULT_OPERATION_CLAIM_INTERVAL_MS,
      ),
    ),
    taskTimeoutMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "task-timeout")
          ?? process.env.DOFE_AGENT_TASK_TIMEOUT_MS
          ?? 12 * 60 * 60 * 1000,
      ),
    ),
    manageFeishuWorker: process.env.DOFE_AGENT_MANAGE_FEISHU_WORKER !== "0"
      && process.env.DOFE_AGENT_MANAGE_FEISHU_WORKER !== "false",
    serverUrl: getStringFlag(flags, "server-url")?.trim(),
    daemonToken: getStringFlag(flags, "daemon-token")?.trim(),
  };
}
export function detectProviders(): DetectedProvider[] {
  return detectSharedProviders();
}
