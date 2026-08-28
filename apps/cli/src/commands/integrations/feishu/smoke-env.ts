// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  listExternalIntegrationsSync,
  type ExternalIntegrationRecord
} from "@dofe-agent/db";
import { FEISHU_AGENT_BOT_REQUIRED_CREDENTIAL_FIELDS, FEISHU_BOT_SMOKE_SCOPES, FEISHU_DATA_PLANE_SMOKE_SCOPES, FEISHU_OPEN_PLATFORM_CONSOLE_URLS, FEISHU_OPEN_PLATFORM_SETUP_STEPS, FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS, FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS, FEISHU_PROVIDER_ID, FEISHU_REQUIRED_CREDENTIAL_FIELDS, resolveFeishuRequiredEventTypes, resolveFeishuEventSubscriptionSetupRequirements } from "@dofe-agent/services/integrations";
import { hasNonEmptyString } from "./evidence.ts";
import { buildFeishuCliEventCallbackUrl, normalizeFeishuCliPublicAppUrl } from "./readiness.ts";
import { FEISHU_CLI_PLACEHOLDERS } from "./types.ts";
import type { BuildFeishuSmokeEnvTemplateReportInput, FeishuCredentialEncryptionReadiness, FeishuIntegrationReadiness, FeishuOpenPlatformSetupStep, FeishuOpenPlatformSetupSummary, FeishuRuntimeSetupSummary, FeishuSmokeEnvTemplateReport, FeishuSmokeHarnessSummary } from "./types.ts";

export function buildFeishuSmokeEnvIntegrationIssues(input: {
  scopedIntegrationId?: string;
  integrations: readonly ExternalIntegrationRecord[];
  selectedIntegration: ExternalIntegrationRecord | undefined;
}): string[] {
  if (input.selectedIntegration) {
    return [];
  }
  if (input.integrations.length === 0) {
    return ["integration_missing"];
  }
  const hasActiveIntegration = input.integrations.some((integration) => integration.status === "active");
  const hasActiveWorkspaceLevelIntegration = input.integrations.some((integration) =>
    integration.status === "active" && !hasNonEmptyString(integration.agentId)
  );
  if (input.scopedIntegrationId && hasActiveWorkspaceLevelIntegration) {
    return ["selected_integration_not_agent_bot"];
  }
  if (hasActiveWorkspaceLevelIntegration) {
    return ["active_agent_bot_integration_missing"];
  }
  if (input.scopedIntegrationId || !hasActiveIntegration) {
    return ["selected_integration_not_active"];
  }
  return ["integration_missing"];
}
export function buildFeishuSmokeEnvTemplateReport(
  input: BuildFeishuSmokeEnvTemplateReportInput,
): FeishuSmokeEnvTemplateReport {
  const integrations = (input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  })).filter((integration) => !input.integrationId || integration.id === input.integrationId);
  const selectedIntegration = integrations.find((integration) =>
    integration.status === "active" && hasNonEmptyString(integration.agentId)
  );
  const appUrl = normalizeFeishuCliPublicAppUrl(input.appUrl);
  const callbackUrl = selectedIntegration && appUrl
    ? buildFeishuCliEventCallbackUrl({
      appUrl,
      workspaceId: input.workspaceId,
      integrationId: selectedIntegration.id,
    })
    : "CHANGE_ME_DOFE_AGENT_CALLBACK_URL";
  const appId = selectedIntegration?.appId?.trim();
  const tenantKey = selectedIntegration?.tenantKey?.trim();
  const issues = [
    ...buildFeishuSmokeEnvIntegrationIssues({
      scopedIntegrationId: input.integrationId,
      integrations,
      selectedIntegration,
    }),
    ...(selectedIntegration && !appId ? ["app_id_missing"] : []),
    ...(!appUrl ? ["app_url_missing"] : []),
  ];

  return {
    workspaceId: input.workspaceId,
    integrationCount: integrations.length,
    selectedIntegrationId: selectedIntegration?.id,
    appUrl,
    envFilePath: "scripts/feishu/.env",
    issues,
    entries: [
      {
        key: "FEISHU_APP_ID",
        value: appId || "CHANGE_ME_FEISHU_APP_ID",
        secret: false,
        required: true,
        source: appId ? "integration" : "placeholder",
      },
      ...(tenantKey
        ? [{
          key: "FEISHU_TENANT_KEY",
          value: tenantKey,
          secret: false,
          required: false,
          source: "integration" as const,
          note: "Optional tenant key saved on the DofeAgent integration; strict-live evidence stores only its hash.",
        }]
        : []),
      {
        key: "FEISHU_APP_SECRET",
        value: "CHANGE_ME_FEISHU_APP_SECRET",
        secret: true,
        required: true,
        source: "placeholder",
        note: "Fill from Feishu developer console; DofeAgent never prints saved app secrets.",
      },
      {
        key: "FEISHU_VERIFICATION_TOKEN",
        value: "CHANGE_ME_FEISHU_VERIFICATION_TOKEN",
        secret: true,
        required: true,
        source: "placeholder",
        note: "Use the same verification token saved on the DofeAgent integration.",
      },
      {
        key: "FEISHU_ENCRYPT_KEY",
        value: "CHANGE_ME_FEISHU_ENCRYPT_KEY",
        secret: true,
        required: false,
        source: "placeholder",
        note: "Use when Feishu event encryption is enabled; create can read it via --encrypt-key-env.",
      },
      {
        key: "FEISHU_SECOND_AGENT_APP_ID",
        value: "CHANGE_ME_SECOND_AGENT_APP_ID",
        secret: false,
        required: false,
        source: "placeholder",
        note: "Optional for isolated OpenAPI smoke; required for TODO120 Phase 6 multi-agent smoke as the second disposable Feishu app id. After filling it, bind the self-built second app with: dofe-agent integrations feishu bind-agent-bot --workspace-id <id> --agent <second-agent> --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --transport websocket_worker --json",
      },
      {
        key: "FEISHU_SECOND_AGENT_APP_SECRET",
        value: "CHANGE_ME_SECOND_AGENT_APP_SECRET",
        secret: true,
        required: false,
        source: "placeholder",
        note: "Optional for isolated OpenAPI smoke; required for TODO120 Phase 6 multi-agent smoke as the second Feishu app secret. This env value only feeds the bind-agent-bot command; DofeAgent still needs a real second agent bot binding before same-group reuse and thread-collaboration smoke can pass.",
      },
      {
        key: "FEISHU_API_BASE_URL",
        value: process.env.DOFE_AGENT_FEISHU_API_BASE_URL?.trim() || "https://open.feishu.cn",
        secret: false,
        required: false,
        source: process.env.DOFE_AGENT_FEISHU_API_BASE_URL?.trim() ? "env" : "placeholder",
      },
      {
        key: "FEISHU_SMOKE_CALLBACK_URL",
        value: callbackUrl,
        secret: false,
        required: true,
        source: appUrl && selectedIntegration ? "app-url" : "placeholder",
        note: "Generated from --app-url/DOFE_AGENT_APP_URL plus workspace/integration ids.",
      },
      {
        key: "FEISHU_SMOKE_CHAT_ID",
        value: "CHANGE_ME_FEISHU_CHAT_ID",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_DOC_TOKEN",
        value: "CHANGE_ME_DOCX_TOKEN",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_DOC_PARENT_BLOCK_ID",
        value: "CHANGE_ME_DOCX_PARENT_BLOCK_ID",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_DOC_APPEND_BLOCKS_JSON",
        value: "[{\"block_type\":2,\"text\":{\"elements\":[{\"text_run\":{\"content\":\"DofeAgent smoke\"}}]}}]",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_SHEET_TOKEN",
        value: "CHANGE_ME_SHEET_TOKEN",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_SHEET_RANGE",
        value: "Sheet1!A1:B2",
        secret: false,
        required: false,
        source: "placeholder",
        note: "Optional sheet read range; strict live smoke defaults to this range when unset.",
      },
      {
        key: "FEISHU_SMOKE_SHEET_WRITE_RANGE",
        value: "Sheet1!A1:B1",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_SHEET_WRITE_VALUES_JSON",
        value: "[[\"DofeAgent smoke\"]]",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_BASE_APP_TOKEN",
        value: "CHANGE_ME_BASE_APP_TOKEN",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_BASE_TABLE_ID",
        value: "CHANGE_ME_BASE_TABLE_ID",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_BASE_RECORD_ID",
        value: "CHANGE_ME_BASE_RECORD_ID",
        secret: false,
        required: true,
        source: "placeholder",
      },
      {
        key: "FEISHU_SMOKE_BASE_UPDATE_FIELDS_JSON",
        value: "{\"Smoke\":\"DofeAgent\"}",
        secret: false,
        required: true,
        source: "placeholder",
      },
    ],
  };
}
export interface FeishuDataPlaneSmokeCommands {
  liveDocReadCommand: string;
  liveDocWriteCommand: string;
  liveSheetReadCommand: string;
  liveSheetWriteCommand: string;
  liveBaseCommand: string;
}
export interface FeishuExternalGuestPolicySmokeCommands {
  replyOnMentionCommand: string;
  replyAllCommand: string;
  requireIdentityCommand: string;
  ignoreCommand: string;
  restoreDefaultCommand: string;
}
export interface FeishuAgentChannelAccessSmokeCommands {
  disableCommand: string;
  restoreCommand: string;
}
export function buildFeishuDataPlaneSmokeCommands(input: {
  workspaceId: string;
  integrationId: string;
}): FeishuDataPlaneSmokeCommands {
  const reviewDataOperationCommand = `dofe-agent integrations feishu review-data-operation --workspace-id ${input.workspaceId} --approval-id ${FEISHU_CLI_PLACEHOLDERS.approvalId} --decision approved --json`;
  return {
    liveDocReadCommand: `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation read-doc --resource ${FEISHU_CLI_PLACEHOLDERS.docResource} --json`,
    liveDocWriteCommand: [
      `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation plan-doc-append --resource ${FEISHU_CLI_PLACEHOLDERS.docResource} --parent-block-id ${FEISHU_CLI_PLACEHOLDERS.docBlockId} --blocks-json '[{"block_type":2,"text":{"elements":[{"text_run":{"content":"DofeAgent smoke"}}]}}]' --approval-agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --approval-channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --json`,
      reviewDataOperationCommand,
    ].join("\n"),
    liveSheetReadCommand: `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation read-sheet --resource ${FEISHU_CLI_PLACEHOLDERS.sheetResource} --range ${FEISHU_CLI_PLACEHOLDERS.sheetRange} --json`,
    liveSheetWriteCommand: [
      `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation plan-sheet-write --resource ${FEISHU_CLI_PLACEHOLDERS.sheetResource} --range ${FEISHU_CLI_PLACEHOLDERS.sheetWriteRange} --values-json '[["DofeAgent smoke"]]' --approval-agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --approval-channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --json`,
      reviewDataOperationCommand,
    ].join("\n"),
    liveBaseCommand: [
      `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation query-base --resource ${FEISHU_CLI_PLACEHOLDERS.baseResource} --json`,
      `dofe-agent integrations feishu data-operation --workspace-id ${input.workspaceId} --integration ${input.integrationId} --operation plan-base-update --resource ${FEISHU_CLI_PLACEHOLDERS.baseResource} --record-id ${FEISHU_CLI_PLACEHOLDERS.baseRecordId} --fields-json '{"Smoke":"DofeAgent"}' --approval-agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --approval-channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --json`,
      reviewDataOperationCommand,
    ].join("\n"),
  };
}
export function buildFeishuExternalGuestPolicySmokeCommands(input: {
  workspaceId: string;
  integrationId: string;
  agentId?: string;
}): FeishuExternalGuestPolicySmokeCommands {
  const targetFlags = input.agentId
    ? `--agent ${input.agentId}`
    : `--integration ${input.integrationId}`;
  const baseCommand = `dofe-agent integrations feishu auto-provision-policy --workspace-id ${input.workspaceId} ${targetFlags}`;
  const defaultRequireIdentityFor = "--require-identity-for writes,approvals,private_resources,runtime_sensitive_tools";
  return {
    replyOnMentionCommand: `${baseCommand} --unbound-user-mode reply_on_mention --guest-permission-profile channel_context_only ${defaultRequireIdentityFor} --json`,
    replyAllCommand: `${baseCommand} --unbound-user-mode reply_all --guest-permission-profile channel_context_only ${defaultRequireIdentityFor} --json`,
    requireIdentityCommand: `${baseCommand} --unbound-user-mode require_identity --guest-permission-profile none ${defaultRequireIdentityFor} --json`,
    ignoreCommand: `${baseCommand} --unbound-user-mode ignore --guest-permission-profile none ${defaultRequireIdentityFor} --json`,
    restoreDefaultCommand: `${baseCommand} --unbound-user-mode reply_on_mention --guest-permission-profile channel_context_only ${defaultRequireIdentityFor} --json`,
  };
}
export function buildFeishuAgentChannelAccessSmokeCommands(input: {
  workspaceId: string;
  integrationId: string;
  agentId?: string;
}): FeishuAgentChannelAccessSmokeCommands {
  const targetFlags = input.agentId
    ? `--agent ${input.agentId}`
    : `--integration ${input.integrationId}`;
  const baseCommand = `dofe-agent integrations feishu agent-channel-access --workspace-id ${input.workspaceId} ${targetFlags}`;
  return {
    disableCommand: `${baseCommand} --access disabled --json`,
    restoreCommand: `${baseCommand} --access enabled --json`,
  };
}
export function buildFeishuSmokeHarnessSummary(input: {
  workspaceId: string;
  integrationId?: string;
  appUrl?: string;
}): FeishuSmokeHarnessSummary {
  const envExamplePath = "scripts/feishu/env.example";
  const envFilePath = "scripts/feishu/.env";
  const evidencePath = "runtime-output/feishu-smoke/live.json";
  const botAddedPayloadPath = "runtime-output/feishu-smoke/bot-added-callback.json";
  const botAddedPayloadEvidencePath = "runtime-output/feishu-smoke/bot-added-payload-evidence.json";
  const integrationFlag = input.integrationId ? ` --integration ${input.integrationId}` : "";
  const appUrl = normalizeFeishuCliPublicAppUrl(input.appUrl);
  const appUrlFlag = appUrl ?? FEISHU_CLI_PLACEHOLDERS.publicAppUrl;
  const callbackUrl = appUrl && input.integrationId
    ? buildFeishuCliEventCallbackUrl({
      appUrl,
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
    })
    : undefined;
  return {
    envExamplePath,
    envFilePath,
    evidencePath,
    botAddedPayloadPath,
    botAddedPayloadEvidencePath,
    ...(appUrl ? { appUrl } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
    requiredLiveSteps: FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length,
    destructiveLiveChecks: FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS.length,
    destructiveLiveStepNames: [...FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS],
    prepareEnvCommand: `dofe-agent integrations feishu smoke-env --workspace-id ${input.workspaceId}${integrationFlag} --app-url ${appUrlFlag} > ${envFilePath}`,
    checkEnvCommand: `pnpm run smoke:feishu -- --env-file ${envFilePath} --check-env --json --require-todo120-native`,
    strictLiveCommand: `pnpm run smoke:feishu -- --env-file ${envFilePath} --live --strict-live --evidence ${evidencePath} --json --require-todo120-native`,
    verifyEvidenceCommand: `pnpm run smoke:feishu -- --verify-evidence ${evidencePath} --json`,
    verifyBotAddedPayloadCommand: `pnpm run smoke:feishu -- --verify-bot-added-payload ${botAddedPayloadPath} --bot-added-payload-evidence ${botAddedPayloadEvidencePath} --json`,
  };
}
export function buildFeishuOpenPlatformSetupSummary(input: {
  hasIntegration: boolean;
  hasAppUrl: boolean;
  callbackUrl?: string;
  transportMode?: string;
  requiredCredentialFields?: readonly string[];
}): FeishuOpenPlatformSetupSummary {
  return {
    callbackUrlStatus: input.callbackUrl
      ? "ready"
      : input.hasIntegration && !input.hasAppUrl
        ? "app_url_missing"
        : "integration_missing",
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    developerConsoleUrl: FEISHU_OPEN_PLATFORM_CONSOLE_URLS.appList,
    requiredCredentialFields: [...(input.requiredCredentialFields ?? FEISHU_REQUIRED_CREDENTIAL_FIELDS)],
    requiredEvents: [...resolveFeishuRequiredEventTypes(input.transportMode)],
    botScopes: [...FEISHU_BOT_SMOKE_SCOPES],
    dataPlaneScopes: [...FEISHU_DATA_PLANE_SMOKE_SCOPES],
    setupSteps: buildFeishuOpenPlatformSetupSteps(input.transportMode),
  };
}
export function resolveFeishuCliOpenPlatformRequiredCredentialFields(
  integration: FeishuIntegrationReadiness | undefined,
): readonly string[] {
  if (!integration || (integration.agentId && integration.transportMode === "websocket_worker")) {
    return FEISHU_AGENT_BOT_REQUIRED_CREDENTIAL_FIELDS;
  }
  return FEISHU_REQUIRED_CREDENTIAL_FIELDS;
}
export function buildFeishuOpenPlatformSetupSteps(transportMode?: string): FeishuOpenPlatformSetupStep[] {
  return FEISHU_OPEN_PLATFORM_SETUP_STEPS.map((step) => ({
    id: step.id,
    consoleUrl: step.consoleUrl,
    required: step.id === "configure_event_subscription"
      ? [...resolveFeishuEventSubscriptionSetupRequirements(transportMode)]
      : [...step.required],
  }));
}
export function buildFeishuRuntimeSetupSummary(env: Record<string, string | undefined> = process.env): FeishuRuntimeSetupSummary {
  return {
    credentialEncryption: buildFeishuCredentialEncryptionReadiness(env),
  };
}
export function buildFeishuCredentialEncryptionReadiness(
  env: Record<string, string | undefined>,
): FeishuCredentialEncryptionReadiness {
  const checkedEnvNames = [
    "DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY",
    "DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  ];
  const configuredEnvName = checkedEnvNames.find((envName) => Boolean(env[envName]?.trim()));
  if (!configuredEnvName) {
    return {
      status: "missing",
      checkedEnvNames,
      issue: "credential_encryption_key_missing",
    };
  }

  const key = Buffer.from(env[configuredEnvName]?.trim() ?? "", "base64");
  if (key.length !== 32) {
    return {
      status: "invalid",
      checkedEnvNames,
      configuredEnvName,
      issue: "credential_encryption_key_invalid",
    };
  }

  return {
    status: "ready",
    checkedEnvNames,
    configuredEnvName,
  };
}
export function renderFeishuSmokeEnvTemplate(report: FeishuSmokeEnvTemplateReport): string {
  const lines = [
    "# DofeAgent Feishu smoke env",
    "# Generated by: dofe-agent integrations feishu smoke-env",
    `# Workspace: ${report.workspaceId}`,
    `# Integration: ${report.selectedIntegrationId ?? "missing"}`,
    "# Secrets are placeholders. Fill them from the Feishu developer console or the integration setup.",
  ];
  if (report.issues.length > 0) {
    lines.push(`# Issues: ${report.issues.join(", ")}`);
  }
  lines.push("");
  for (const entry of report.entries) {
    if (entry.note) {
      lines.push(`# ${entry.note}`);
    }
    if (entry.secret) {
      lines.push(`# secret: ${entry.key}`);
    }
    lines.push(`${entry.key}=${entry.value}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
export function formatFeishuSmokeEnvCommandText(
  report: FeishuSmokeEnvTemplateReport,
): { stdout?: string; stderr?: string } {
  if (report.issues.length > 0) {
    return {
      stderr: `Feishu smoke-env is not ready (${report.issues.join(", ")}). Fix the DofeAgent Feishu integration setup and rerun smoke-env; no env template was printed.`,
    };
  }

  return {
    stdout: renderFeishuSmokeEnvTemplate(report),
  };
}
export function getFeishuSmokeEnvExitCode(report: Pick<FeishuSmokeEnvTemplateReport, "issues">): number {
  return report.issues.length > 0 ? 1 : 0;
}
