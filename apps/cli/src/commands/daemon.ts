// daemon CLI（拆分后收敛为 barrel）：命令分发在 ./daemon/command，各域实现见同目录子模块。
// 公共导出面与拆分前一致，引用方（src/index.ts 与 daemon.test.ts）零改动。

export { isMissingDaemonRegistrationError, resolveRequiredLocalProviders, runDaemonCommand, startManagedFeishuWorker } from "./daemon/command.ts";
export { buildDaemonConfig } from "./daemon/config.ts";
export { buildTaskPrompt } from "../lib/daemon-task-context.ts";
export { clearTaskOutputArtifacts, loadTaskOutputEnvelope } from "../lib/daemon-task-output.ts";
