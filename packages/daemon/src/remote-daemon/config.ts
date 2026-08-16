// 3.5-4：自 remote-daemon.ts 拆出——RemoteDaemonConfig 类型、flag/env 解析与帮助文本。
import { getStringFlag } from "../args.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_OPERATION_CLAIM_INTERVAL_MS,
  DEFAULT_TASK_POLL_INTERVAL_MS,
  resolveDefaultDaemonStateDir,
} from "../state.ts";

export interface RemoteDaemonConfig {
  stateDir: string;
  daemonKey: string;
  deviceName: string;
  runtimeName: string;
  heartbeatIntervalMs: number;
  taskPollIntervalMs: number;
  /** 3.5-8：同一 runtime 两次操作队列 claim 级联的最小间隔（空闲背压）。 */
  operationClaimIntervalMs: number;
  taskTimeoutMs: number;
  serverUrl?: string;
  daemonToken?: string;
  managedNode: boolean;
  codexMcpExperimentalEnabled: boolean;
}

export function buildRemoteDaemonConfig(
  flags: Record<string, string | boolean>,
  options?: { environment?: NodeJS.ProcessEnv; defaultStateDir?: string },
): RemoteDaemonConfig {
  const environment = options?.environment ?? process.env;
  const hostname = environment.HOSTNAME || environment.COMPUTERNAME || "remote-daemon";

  return {
    stateDir:
      getStringFlag(flags, "state-dir")?.trim()
      || environment.DOFE_AGENT_DAEMON_STATE_DIR?.trim()
      || options?.defaultStateDir
      || resolveDefaultDaemonStateDir(environment),
    daemonKey: getStringFlag(flags, "daemon-id")?.trim() || environment.DOFE_AGENT_DAEMON_ID?.trim() || hostname,
    deviceName: getStringFlag(flags, "device-name")?.trim() || environment.DOFE_AGENT_DEVICE_NAME?.trim() || hostname,
    runtimeName: getStringFlag(flags, "runtime-name")?.trim() || environment.DOFE_AGENT_RUNTIME_NAME?.trim() || "Remote Agent",
    heartbeatIntervalMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "heartbeat-interval")
          ?? environment.DOFE_AGENT_HEARTBEAT_INTERVAL
          ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      ),
    ),
    taskPollIntervalMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "poll-interval")
          ?? environment.DOFE_AGENT_TASK_POLL_INTERVAL
          ?? DEFAULT_TASK_POLL_INTERVAL_MS,
      ),
    ),
    operationClaimIntervalMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "operation-claim-interval")
          ?? environment.DOFE_AGENT_OPERATION_CLAIM_INTERVAL
          ?? DEFAULT_OPERATION_CLAIM_INTERVAL_MS,
      ),
    ),
    taskTimeoutMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "task-timeout")
          ?? environment.DOFE_AGENT_TASK_TIMEOUT_MS
          ?? 12 * 60 * 60 * 1000,
      ),
    ),
    serverUrl: getStringFlag(flags, "server-url")?.trim() || environment.DOFE_AGENT_SERVER_URL?.trim(),
    daemonToken: getStringFlag(flags, "daemon-token")?.trim() || environment.DOFE_AGENT_DAEMON_TOKEN?.trim(),
    managedNode: flags["managed-node"] === true || environment.DOFE_AGENT_MANAGED_NODE === "1" || environment.DOFE_AGENT_MANAGED_NODE === "true",
    codexMcpExperimentalEnabled: environment.MCP_CODEX_EXPERIMENTAL_ENABLED === "1",
  };
}

export function printRemoteDaemonHelp(): void {
  console.log(`dofe-agent-daemon

Usage:
  dofe-agent-daemon start [--foreground] [--managed-node] [--server-url <url>] [--daemon-token <token>] [--daemon-id <id>] [--device-name <name>] [--runtime-name <label>] [--heartbeat-interval <ms>] [--poll-interval <ms>] [--operation-claim-interval <ms>] [--task-timeout <ms>] [--state-dir <dir>]
  dofe-agent-daemon stop [--state-dir <dir>]
  dofe-agent-daemon status [--json] [--state-dir <dir>]
  dofe-agent-daemon logs [--lines <n>] [--follow] [--state-dir <dir>]

Environment:
  DOFE_AGENT_SERVER_URL
  DOFE_AGENT_DAEMON_TOKEN
  DOFE_AGENT_DAEMON_ID
  DOFE_AGENT_DEVICE_NAME
  DOFE_AGENT_RUNTIME_NAME
  DOFE_AGENT_MANAGED_NODE
  DOFE_AGENT_PROVIDER_ACCOUNT_ID
  DOFE_AGENT_DAEMON_STATE_DIR
  DOFE_AGENT_HEARTBEAT_INTERVAL
  DOFE_AGENT_TASK_POLL_INTERVAL
  DOFE_AGENT_OPERATION_CLAIM_INTERVAL
  DOFE_AGENT_TASK_TIMEOUT_MS
  MCP_CODEX_EXPERIMENTAL_ENABLED

Examples:
  dofe-agent-daemon start --foreground --server-url https://dofe-agent.example --daemon-token adt_xxx
  dofe-agent-daemon status --json
  dofe-agent-daemon logs --follow`);
}
