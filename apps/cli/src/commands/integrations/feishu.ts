// 飞书集成 CLI（3.6-3 拆分后收敛为 barrel）：命令分发在 ./feishu/command，
// 各域实现见同目录子模块。公共导出面与拆分前一致，引用方零改动。

export { buildFeishuAgentBotCliInputFromFlags, buildFeishuAgentBotPolicyCliInputFromFlags, buildFeishuAgentChannelAccessCliInputFromFlags, buildFeishuCliAgentBotErrorReport, createFeishuAgentBotBindingForCli, disableFeishuAgentBotForCli, rotateFeishuAgentBotCredentialsForCli, setFeishuAgentChannelAccessForCli, updateFeishuAgentBotPolicyForCli } from "./feishu/agent-bot.ts";
export { buildFeishuChannelBindingsCliReport, buildFeishuCliBindingErrorReport, createFeishuChannelBindingForCli, createFeishuResourceBindingForCli, createFeishuUserBindingForCli } from "./feishu/bindings.ts";
export { runFeishuIntegrationCommand } from "./feishu/command.ts";
export { buildFeishuCreateCliInputFromFlags, createFeishuIntegrationForCli, readFeishuCreateCliEnv } from "./feishu/create.ts";
export { buildFeishuCliDataOperationParameters, runFeishuDataOperationApprovalReviewForCli, runFeishuDataOperationForCli } from "./feishu/data-operations.ts";
export { buildFeishuEvidenceReport, formatFeishuEvidenceCommandText } from "./feishu/evidence.ts";
export { buildFeishuReadinessReport, runFeishuHealthCheckCli } from "./feishu/readiness.ts";
export { buildFeishuSmokeEnvTemplateReport, formatFeishuSmokeEnvCommandText, getFeishuSmokeEnvExitCode } from "./feishu/smoke-env.ts";
export { buildFeishuSmokePlanReport, formatFeishuSmokePlanCommandText, getFeishuSmokePlanExitCode } from "./feishu/smoke-plan.ts";
export { getFeishuWorkerExitCode } from "./feishu/worker.ts";
export type { FeishuAgentBotCliInput, FeishuAgentBotCliResult, FeishuAgentBotNextCommands, FeishuAgentChannelAccessCliInput, FeishuAgentChannelAccessCliResult, FeishuAgentChannelMemberAccess, FeishuBindingCliResult, FeishuBotAddedPayloadEvidenceVerification, FeishuChannelBindingCliItem, FeishuChannelBindingsCliReport, FeishuChannelBindingsIntegrationSummary, FeishuCliErrorReport, FeishuCredentialEncryptionReadiness, FeishuDataOperationApprovalReviewCliResult, FeishuDataOperationCliResult, FeishuEvidenceRemediationStep, FeishuEvidenceReport, FeishuHealthCheckCliItem, FeishuHealthCheckCliReport, FeishuIntegrationCreateCliInput, FeishuIntegrationCreateCliResult, FeishuIntegrationEvidence, FeishuIntegrationReadiness, FeishuLocalEvidenceFreshnessSummary, FeishuOpenApiSmokeEvidenceVerification, FeishuOpenPlatformSetupStep, FeishuOpenPlatformSetupSummary, FeishuReadinessReport, FeishuReadinessSetupCheck, FeishuReadinessSetupCheckStatus, FeishuRuntimeSetupSummary, FeishuSmokeEnvTemplateEntry, FeishuSmokeEnvTemplateReport, FeishuSmokeHarnessSummary, FeishuSmokePlanBlocker, FeishuSmokePlanEvidenceGate, FeishuSmokePlanEvidenceGateKey, FeishuSmokePlanReport, FeishuSmokePlanStep, FeishuWorkerHarnessSummary } from "./feishu/types.ts";
