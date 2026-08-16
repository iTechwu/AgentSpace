// 3.5-4：原 2178 行单文件按职责拆分至 remote-daemon/ 子模块。本文件保留为
// barrel，显式重导出原有公共面（见 git 历史取拆分前实现）；模块间内部
// 依赖（ensureManagedRuntimeHomeDir 等）不在此暴露。
export type { RemoteRuntimeActivity } from "./remote-daemon/activity.ts";
export {
  beginRemoteRuntimeTask,
  createRemoteRuntimeActivity,
  endRemoteRuntimeTask,
  releaseRemoteRuntimeExclusiveSlot,
  reserveRemoteRuntimeExclusiveSlot,
} from "./remote-daemon/activity.ts";
export type { RemoteDaemonConfig } from "./remote-daemon/config.ts";
export { buildRemoteDaemonConfig, printRemoteDaemonHelp } from "./remote-daemon/config.ts";
export type { RemoteLoopErrorAction } from "./remote-daemon/errors.ts";
export { classifyRemoteLoopError } from "./remote-daemon/errors.ts";
export { claimRemoteQueue } from "./remote-daemon/queue.ts";
export type { RemoteGatewayUsageReporter } from "./remote-daemon/usage.ts";
export { createRemoteGatewayUsageReporter, mergeRemoteGatewayUsages } from "./remote-daemon/usage.ts";
export { buildManagedStdioLaunch, resolveManagedServiceConnection } from "./remote-daemon/mcp.ts";
export type { ManagedRuntimeEntry } from "./remote-daemon/heartbeat.ts";
export {
  buildRemoteRuntimeHeartbeatMetadata,
  reconcileRemoteRuntimesWithHeartbeat,
  resolveManagedProviderVerificationEnvironments,
  resolveRemoteRuntimeCliHubReadiness,
  restoreManagedRuntimesFromHeartbeat,
} from "./remote-daemon/heartbeat.ts";
export type { RemoteDaemonRelaunchCommand } from "./remote-daemon/command.ts";
export {
  DAEMON_AUTH_REJECTED_MESSAGE,
  buildRemoteDaemonRelaunchCommand,
  runRemoteDaemonCommand,
  runRemoteDaemonForeground,
} from "./remote-daemon/command.ts";
export {
  resolveRemoteTaskExecutionModel,
  resolveRemoteTaskExecutionSessionId,
  resolveRemoteTaskProviderSessionId,
  resolveRemoteTaskWorkDir,
  watchRemoteTaskCancellation,
} from "./remote-daemon/task-execution.ts";
