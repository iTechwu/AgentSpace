// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import { readFileSync } from "node:fs";
import {
  createExternalIntegrationSync,
  type ExternalIntegrationRecord
} from "@dofe-agent/db";
import { buildEncryptedFeishuCredentials, FEISHU_DEFAULT_SCOPES, FEISHU_EVENT_CALLBACK_PATH, FEISHU_PROVIDER_ID, FEISHU_REQUIRED_CREDENTIAL_FIELDS, resolveFeishuRequiredEventTypes } from "@dofe-agent/services/integrations";
import { tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services/workspace";
import { getStringFlag } from "../../../lib/args.ts";
import { normalizeOptionalText, parseFeishuCliEnvFile, parseFeishuCliTransportMode, readStringFlagOrEnv, requireNonEmpty, requireNonPlaceholderFeishuCreateValue, requireStringFlagOrEnv, validateOptionalFeishuCreateValue } from "./cli-shared.ts";
import { buildFeishuOpenPlatformSetupSummary, buildFeishuSmokeHarnessSummary } from "./smoke-env.ts";
import { FEISHU_CLI_PLACEHOLDERS } from "./types.ts";
import type { FeishuCliErrorReport, FeishuIntegrationCreateCliInput, FeishuIntegrationCreateCliResult } from "./types.ts";

export function createFeishuIntegrationForCli(
  input: FeishuIntegrationCreateCliInput,
  deps: {
    createIntegration?: typeof createExternalIntegrationSync;
    encryptCredentials?: typeof buildEncryptedFeishuCredentials;
    auditRecorder?: typeof tryRecordWorkspaceAuditEventSync;
  } = {},
): FeishuIntegrationCreateCliResult {
  const createIntegration = deps.createIntegration ?? createExternalIntegrationSync;
  const encryptCredentials = deps.encryptCredentials ?? buildEncryptedFeishuCredentials;
  const auditRecorder = deps.auditRecorder ?? tryRecordWorkspaceAuditEventSync;
  const displayName = normalizeOptionalText(input.displayName) ?? "Feishu";
  const transportMode = parseFeishuCliTransportMode(input.transportMode);
  const appId = requireNonEmpty(input.appId, "feishu.create.missing_app_id");
  const appSecret = requireNonEmpty(input.appSecret, "feishu.create.missing_app_secret");
  const verificationToken = requireNonEmpty(input.verificationToken, "feishu.create.missing_verification_token");
  const encryptKey = normalizeOptionalText(input.encryptKey);
  const tenantKey = normalizeOptionalText(input.tenantKey);

  let encryptedCredentialsJson: Record<string, string>;
  try {
    encryptedCredentialsJson = encryptCredentials({
      appSecret,
      verificationToken,
      encryptKey,
    });
  } catch (error) {
    throw normalizeFeishuCreateCliError(error);
  }

  let integration: ExternalIntegrationRecord;
  try {
    integration = createIntegration({
      workspaceId: input.workspaceId,
      provider: FEISHU_PROVIDER_ID,
      displayName,
      transportMode,
      appId,
      tenantKey,
      encryptedCredentialsJson,
      configJson: {
        eventCallbackPath: FEISHU_EVENT_CALLBACK_PATH,
        dataPlane: {
          docs: true,
          sheets: true,
          base: true,
        },
      },
      capabilitiesJson: {
        messageTransport: true,
        docsDataPlane: true,
        sheetsDataPlane: true,
        baseDataPlane: true,
      },
      scopesJson: [...FEISHU_DEFAULT_SCOPES],
      createdByUserId: normalizeOptionalText(input.createdByUserId),
    });
  } catch (error) {
    throw normalizeFeishuCreateCliError(error);
  }
  const flags = `--workspace-id ${input.workspaceId} --integration ${integration.id}`;
  const appUrlFlag = normalizeOptionalText(input.appUrl)
    ? ` --app-url ${normalizeOptionalText(input.appUrl)}`
    : "";
  const smokeHarness = buildFeishuSmokeHarnessSummary({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    appUrl: input.appUrl,
  });
  const auditRecorded = auditRecorder({
    workspaceId: input.workspaceId,
    title: "Feishu integration created from CLI",
    note: `Feishu CLI created integration "${integration.displayName}".`,
    code: "workspace.external_integration_created",
    data: {
      actorType: "cli",
      resourceType: "external_integration",
      resourceId: integration.id,
      provider: FEISHU_PROVIDER_ID,
      transportMode: integration.transportMode,
      appId: integration.appId,
      tenantKeyConfigured: Boolean(integration.tenantKey),
      secretRedacted: true,
    },
  });

  return {
    ok: true,
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    displayName: integration.displayName,
    status: integration.status,
    transportMode: integration.transportMode,
    appId: integration.appId ?? "",
    tenantKeyConfigured: Boolean(integration.tenantKey),
    credentialsStored: {
      appSecret: true,
      verificationToken: true,
      encryptKey: Boolean(encryptKey),
    },
    requiredCredentialFields: [...FEISHU_REQUIRED_CREDENTIAL_FIELDS],
    requiredEvents: [...resolveFeishuRequiredEventTypes(transportMode)],
    requiredScopeCount: FEISHU_DEFAULT_SCOPES.length,
    openPlatformSetup: buildFeishuOpenPlatformSetupSummary({
      hasIntegration: true,
      hasAppUrl: Boolean(smokeHarness.appUrl),
      callbackUrl: smokeHarness.callbackUrl,
      transportMode,
    }),
    secretRedacted: true,
    auditRecorded,
    nextCommands: {
      healthCheck: `dofe-agent integrations feishu health-check ${flags} --strict --json`,
      smokePlan: `dofe-agent integrations feishu smoke-plan ${flags}${appUrlFlag}`,
      smokeEnv: smokeHarness.prepareEnvCommand,
      checkEnv: smokeHarness.checkEnvCommand,
      strictLiveSmoke: smokeHarness.strictLiveCommand,
      verifyOpenApiEvidence: smokeHarness.verifyEvidenceCommand,
      verifyBotAddedPayload: smokeHarness.verifyBotAddedPayloadCommand,
      finalEvidence: `dofe-agent integrations feishu evidence ${flags} --openapi-evidence ${smokeHarness.evidencePath} --bot-added-payload-evidence ${smokeHarness.botAddedPayloadEvidencePath} --strict --require all`,
      bindSecondAgentBot: `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.secondAgentName} --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --json`,
      bindChannel: `dofe-agent integrations feishu bind-channel ${flags} --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --chat-id ${FEISHU_CLI_PLACEHOLDERS.feishuChatId} --json`,
      bindUser: `dofe-agent integrations feishu bind-user ${flags} --user-id ${FEISHU_CLI_PLACEHOLDERS.dofeAgentUserId} --open-id ${FEISHU_CLI_PLACEHOLDERS.feishuOpenId} --json`,
      bindResourceDoc: `dofe-agent integrations feishu bind-resource ${flags} --type doc --resource ${FEISHU_CLI_PLACEHOLDERS.docResource} --dofe-agent-type channel_document --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
      bindResourceSheet: `dofe-agent integrations feishu bind-resource ${flags} --type sheet --resource ${FEISHU_CLI_PLACEHOLDERS.sheetResource} --dofe-agent-type data_table --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
      bindResourceBase: `dofe-agent integrations feishu bind-resource ${flags} --type base_table --resource ${FEISHU_CLI_PLACEHOLDERS.baseResource} --dofe-agent-type data_table --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
    },
  };
}
export function buildFeishuCreateCliInputFromFlags(input: {
  workspaceId: string;
  flags: Record<string, string | boolean>;
  createdByUserId?: string;
  appUrl?: string;
  env?: Record<string, string | undefined>;
}): FeishuIntegrationCreateCliInput {
  const appId = requireNonPlaceholderFeishuCreateValue("app_id", requireStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["app-id", "app_id"],
    envFlagKeys: ["app-id-env", "app_id_env"],
    defaultEnvNames: ["FEISHU_APP_ID", "DOFE_AGENT_FEISHU_APP_ID"],
    missingCode: "feishu.create.missing_app_id",
    env: input.env,
  }));
  const appSecret = requireNonPlaceholderFeishuCreateValue("app_secret", requireStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["app-secret", "app_secret"],
    envFlagKeys: ["app-secret-env", "app_secret_env"],
    defaultEnvNames: ["FEISHU_APP_SECRET", "DOFE_AGENT_FEISHU_APP_SECRET"],
    missingCode: "feishu.create.missing_app_secret",
    env: input.env,
  }));
  const verificationToken = requireNonPlaceholderFeishuCreateValue("verification_token", requireStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["verification-token", "verification_token"],
    envFlagKeys: ["verification-token-env", "verification_token_env"],
    defaultEnvNames: ["FEISHU_VERIFICATION_TOKEN", "DOFE_AGENT_FEISHU_VERIFICATION_TOKEN"],
    missingCode: "feishu.create.missing_verification_token",
    env: input.env,
  }));
  const encryptKey = validateOptionalFeishuCreateValue("encrypt_key", readStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["encrypt-key", "encrypt_key"],
    envFlagKeys: ["encrypt-key-env", "encrypt_key_env"],
    defaultEnvNames: ["FEISHU_ENCRYPT_KEY", "DOFE_AGENT_FEISHU_ENCRYPT_KEY"],
    env: input.env,
  }));
  const tenantKey = validateOptionalFeishuCreateValue("tenant_key", readStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["tenant-key", "tenant_key"],
    envFlagKeys: ["tenant-key-env", "tenant_key_env"],
    defaultEnvNames: ["FEISHU_TENANT_KEY", "DOFE_AGENT_FEISHU_TENANT_KEY"],
    env: input.env,
  }));
  return {
    workspaceId: input.workspaceId,
    displayName: getStringFlag(input.flags, "name") ?? getStringFlag(input.flags, "display-name"),
    transportMode: getStringFlag(input.flags, "transport") ?? getStringFlag(input.flags, "mode"),
    appId,
    appSecret,
    verificationToken,
    encryptKey,
    tenantKey,
    createdByUserId: input.createdByUserId,
    appUrl: input.appUrl,
  };
}
export function readFeishuCreateCliEnv(input: {
  envFilePath?: string;
  env?: Record<string, string | undefined>;
} = {}): Record<string, string | undefined> {
  const env = input.env ?? process.env;
  if (!input.envFilePath?.trim()) {
    return env;
  }

  return {
    ...parseFeishuCliEnvFile(readFileSync(input.envFilePath, "utf8")),
    ...env,
  };
}
export function normalizeFeishuCreateCliError(error: unknown): Error {
  const report = buildFeishuCliCreateErrorReport(error);
  return report ? new Error(report.errorCode) : error instanceof Error ? error : new Error(String(error));
}
export function buildFeishuCliCreateErrorReport(error: unknown): FeishuCliErrorReport | undefined {
  const message = error instanceof Error ? error.message : String(error);
  switch (message) {
    case "DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY is required to store Feishu credentials.":
    case "feishu.create.credential_encryption_key_missing":
      return {
        ok: false,
        errorCode: "feishu.create.credential_encryption_key_missing",
        errorMessage: "DofeAgent credential encryption key is missing.",
        nextStep: "export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)",
      };
    case "DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.":
    case "feishu.create.credential_encryption_key_invalid":
      return {
        ok: false,
        errorCode: "feishu.create.credential_encryption_key_invalid",
        errorMessage: "DofeAgent credential encryption key must be a base64-encoded 32-byte key.",
        nextStep: "export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)",
      };
    case "External integration app and tenant are already connected.":
    case "feishu.create.duplicate_app_tenant":
      return {
        ok: false,
        errorCode: "feishu.create.duplicate_app_tenant",
        errorMessage: "This Feishu App ID and Tenant Key are already connected to the workspace.",
      };
    case "feishu.create.missing_app_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu App ID is required.",
        nextStep: "Set --app-id or --app-id-env FEISHU_APP_ID.",
      };
    case "feishu.create.missing_app_secret":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu App Secret is required.",
        nextStep: "Set --app-secret or --app-secret-env FEISHU_APP_SECRET.",
      };
    case "feishu.create.missing_verification_token":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu Verification Token is required.",
        nextStep: "Set --verification-token or --verification-token-env FEISHU_VERIFICATION_TOKEN.",
      };
    case "feishu.create.invalid_transport_mode":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu transport must be http_webhook or websocket_worker.",
      };
  }

  if (message.startsWith("feishu.cli.missing_env_value:")) {
    const envName = message.slice("feishu.cli.missing_env_value:".length);
    return {
      ok: false,
      errorCode: "feishu.create.missing_env_value",
      errorMessage: `Environment variable ${envName} is not set.`,
      nextStep: `Set ${envName} or choose a different --*-env variable.`,
    };
  }
  if (message.startsWith("feishu.create.placeholder_value:")) {
    const fieldName = message.slice("feishu.create.placeholder_value:".length);
    return {
      ok: false,
      errorCode: "feishu.create.placeholder_value",
      errorMessage: `Feishu create input contains a placeholder value for ${fieldName}.`,
      nextStep: `Replace ${fieldName} with the real value from Feishu Open Platform before creating the integration.`,
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_file_line:")) {
    return {
      ok: false,
      errorCode: "feishu.create.invalid_env_file",
      errorMessage: "Feishu create env file contains a line that is not KEY=value.",
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_name:")) {
    return {
      ok: false,
      errorCode: "feishu.create.invalid_env_file",
      errorMessage: "Feishu create env file contains an invalid environment variable name.",
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_file_quote:")) {
    return {
      ok: false,
      errorCode: "feishu.create.invalid_env_file",
      errorMessage: "Feishu create env file contains an unterminated quoted value.",
    };
  }

  return undefined;
}
