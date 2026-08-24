// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  readExternalIntegrationSync,
  type ExternalIntegrationTransportMode
} from "@dofe-agent/db";
import { createFeishuAgentBotBindingSync, disableFeishuAgentBotBindingSync, readFeishuChannelAutoProvisionPolicy, readFeishuExternalParticipantPolicy, summarizeFeishuStoredCredentials, rotateFeishuAgentBotCredentialsSync, updateFeishuAgentBotPolicySync, type FeishuAgentBotChannelAutoProvisioningInput, type FeishuAgentBotExternalGuestPolicyInput, type FeishuAgentBotBinding } from "@dofe-agent/services/integrations";
import { setEmployeeChannelMemberAccessSync } from "@dofe-agent/services/employees";
import { getStringFlag } from "../../../lib/args.ts";
import { normalizeOptionalText, parseFeishuCliTransportMode, readStringFlagByKeys, readStringFlagOrEnv, requireActiveFeishuCliIntegration, requireNonEmpty, requireNonPlaceholderFeishuAgentBotValue, requireNonPlaceholderFeishuBindingValue, requireStringFlagOrEnv, requireStringFlagValue, sameValue, validateOptionalFeishuAgentBotValue } from "./cli-shared.ts";
import { buildFeishuSmokeHarnessSummary } from "./smoke-env.ts";
import { FEISHU_CLI_PLACEHOLDERS } from "./types.ts";
import type { FeishuAgentBotCliInput, FeishuAgentBotCliResult, FeishuAgentBotNextCommands, FeishuAgentChannelAccessCliInput, FeishuAgentChannelAccessCliResult, FeishuAgentChannelMemberAccess, FeishuCliErrorReport } from "./types.ts";

export function createFeishuAgentBotBindingForCli(
  input: FeishuAgentBotCliInput,
  deps: {
    createBinding?: typeof createFeishuAgentBotBindingSync;
  } = {},
): FeishuAgentBotCliResult {
  const createBinding = deps.createBinding ?? createFeishuAgentBotBindingSync;
  const binding = createBinding({
    workspaceId: input.workspaceId,
    agentId: requireNonEmpty(input.agentId, "feishu.agent_bot_binding.missing_agent_id"),
    displayName: normalizeOptionalText(input.displayName),
    transportMode: parseFeishuAgentBotCliTransportMode(input.transportMode),
    appId: requireNonEmpty(input.appId, "feishu.agent_bot_binding.missing_app_id"),
    appSecret: requireNonEmpty(input.appSecret, "feishu.agent_bot_binding.missing_app_secret"),
    tenantKey: normalizeOptionalText(input.tenantKey),
    verificationToken: normalizeOptionalText(input.verificationToken),
    encryptKey: normalizeOptionalText(input.encryptKey),
    createdByUserId: normalizeOptionalText(input.actorUserId),
    ...(input.channelAutoProvisioning ? { channelAutoProvisioning: input.channelAutoProvisioning } : {}),
    ...(input.externalGuestPolicy ? { externalGuestPolicy: input.externalGuestPolicy } : {}),
  });
  return buildFeishuAgentBotCliResult("created", binding);
}
export function rotateFeishuAgentBotCredentialsForCli(
  input: FeishuAgentBotCliInput,
  deps: {
    rotateCredentials?: typeof rotateFeishuAgentBotCredentialsSync;
  } = {},
): FeishuAgentBotCliResult {
  const rotateCredentials = deps.rotateCredentials ?? rotateFeishuAgentBotCredentialsSync;
  const binding = rotateCredentials({
    workspaceId: input.workspaceId,
    integrationId: normalizeOptionalText(input.integrationId),
    agentId: normalizeOptionalText(input.agentId),
    appId: normalizeOptionalText(input.appId),
    appSecret: requireNonEmpty(input.appSecret, "feishu.agent_bot_binding.missing_app_secret"),
    tenantKey: normalizeOptionalText(input.tenantKey),
    verificationToken: normalizeOptionalText(input.verificationToken),
    encryptKey: normalizeOptionalText(input.encryptKey),
    updatedByUserId: normalizeOptionalText(input.actorUserId),
  });
  return buildFeishuAgentBotCliResult("rotated", binding);
}
export function disableFeishuAgentBotForCli(
  input: FeishuAgentBotCliInput,
  deps: {
    disableBinding?: typeof disableFeishuAgentBotBindingSync;
  } = {},
): FeishuAgentBotCliResult {
  const disableBinding = deps.disableBinding ?? disableFeishuAgentBotBindingSync;
  const binding = disableBinding({
    workspaceId: input.workspaceId,
    integrationId: normalizeOptionalText(input.integrationId),
    agentId: normalizeOptionalText(input.agentId),
    updatedByUserId: normalizeOptionalText(input.actorUserId),
  });
  return buildFeishuAgentBotCliResult("disabled", binding);
}
export function updateFeishuAgentBotPolicyForCli(
  input: FeishuAgentBotCliInput,
  deps: {
    updatePolicy?: typeof updateFeishuAgentBotPolicySync;
  } = {},
): FeishuAgentBotCliResult {
  const updatePolicy = deps.updatePolicy ?? updateFeishuAgentBotPolicySync;
  const hasPolicyPatch = Boolean(input.channelAutoProvisioning || input.externalGuestPolicy);
  const binding = updatePolicy({
    workspaceId: input.workspaceId,
    integrationId: normalizeOptionalText(input.integrationId),
    agentId: normalizeOptionalText(input.agentId),
    ...(input.channelAutoProvisioning ? { channelAutoProvisioning: input.channelAutoProvisioning } : {}),
    ...(input.externalGuestPolicy ? { externalGuestPolicy: input.externalGuestPolicy } : {}),
    updatedByUserId: normalizeOptionalText(input.actorUserId),
  });
  return buildFeishuAgentBotCliResult(hasPolicyPatch ? "policy_updated" : "policy_read", binding);
}
export function setFeishuAgentChannelAccessForCli(
  input: FeishuAgentChannelAccessCliInput,
  deps: {
    readIntegration?: typeof readExternalIntegrationSync;
    setAccess?: typeof setEmployeeChannelMemberAccessSync;
  } = {},
): FeishuAgentChannelAccessCliResult {
  const readIntegration = deps.readIntegration ?? readExternalIntegrationSync;
  const setAccess = deps.setAccess ?? setEmployeeChannelMemberAccessSync;
  const resolvedTarget = resolveFeishuAgentChannelAccessTarget({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    integrationId: input.integrationId,
    readIntegration,
  });
  let state: ReturnType<typeof setEmployeeChannelMemberAccessSync>;
  try {
    state = setAccess(resolvedTarget.agentId, input.channelMemberAccess, input.workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Active employee ")) {
      throw new Error("feishu.agent_channel_access.agent_not_found");
    }
    throw error;
  }
  const agent = state.activeEmployees.find((item) => sameValue(item.name, resolvedTarget.agentId));
  if (!agent) {
    throw new Error("feishu.agent_channel_access.agent_not_found");
  }
  return {
    ok: true,
    kind: "agent_channel_access",
    operation: "updated",
    workspaceId: input.workspaceId,
    agentId: agent.name,
    ...(resolvedTarget.integrationId ? { integrationId: resolvedTarget.integrationId } : {}),
    channelMemberAccess: agent.channelMemberAccess ?? input.channelMemberAccess,
    totalActiveEmployees: state.activeEmployees.length,
    nextCommands: buildFeishuAgentChannelAccessNextCommands({
      workspaceId: input.workspaceId,
      agentId: agent.name,
      integrationId: resolvedTarget.integrationId,
    }),
  };
}
export function resolveFeishuAgentChannelAccessTarget(input: {
  workspaceId: string;
  agentId?: string;
  integrationId?: string;
  readIntegration: typeof readExternalIntegrationSync;
}): { agentId: string; integrationId?: string } {
  const agentId = normalizeOptionalText(input.agentId);
  if (agentId) {
    const integrationId = normalizeOptionalText(input.integrationId);
    return {
      agentId: requireNonPlaceholderFeishuAgentBotValue("agent_id", agentId),
      ...(integrationId ? { integrationId } : {}),
    };
  }
  const integrationId = normalizeOptionalText(input.integrationId);
  if (!integrationId) {
    throw new Error("feishu.agent_channel_access.missing_target");
  }
  const integration = requireActiveFeishuCliIntegration({
    workspaceId: input.workspaceId,
    integrationId: requireNonPlaceholderFeishuBindingValue(integrationId, "feishu.integration.placeholder_value"),
    readIntegration: input.readIntegration,
  });
  if (!integration.agentId?.trim()) {
    throw new Error("feishu.agent_channel_access.integration_not_agent_bot");
  }
  return {
    agentId: integration.agentId.trim(),
    integrationId: integration.id,
  };
}
export function buildFeishuAgentChannelAccessNextCommands(input: {
  workspaceId: string;
  agentId: string;
  integrationId?: string;
}): FeishuAgentChannelAccessCliResult["nextCommands"] {
  const targetFlags = `--agent ${input.agentId}`;
  return {
    disableForSmoke: `dofe-agent integrations feishu agent-channel-access --workspace-id ${input.workspaceId} ${targetFlags} --access disabled --json`,
    restoreAfterSmoke: `dofe-agent integrations feishu agent-channel-access --workspace-id ${input.workspaceId} ${targetFlags} --access enabled --json`,
    smokePlan: `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId} ${input.integrationId ? `--integration ${input.integrationId}` : ""}`.trim(),
  };
}
export function buildFeishuAgentBotCliResult(
  operation: FeishuAgentBotCliResult["operation"],
  binding: FeishuAgentBotBinding,
): FeishuAgentBotCliResult {
  return {
    ok: true,
    kind: "agent_bot",
    operation,
    workspaceId: binding.workspaceId,
    integrationId: binding.id,
    agentId: binding.agentId,
    displayName: binding.displayName,
    status: binding.status,
    transportMode: binding.transportMode,
    appId: binding.appId,
    tenantKeyConfigured: Boolean(binding.tenantKey),
    credentials: summarizeFeishuStoredCredentials(binding),
    channelAutoProvisioning: readFeishuChannelAutoProvisionPolicy(binding),
    externalGuestPolicy: readFeishuExternalParticipantPolicy(binding),
    secretRedacted: true,
    nextCommands: buildFeishuAgentBotNextCommands(binding),
  };
}
export function buildFeishuAgentBotNextCommands(binding: FeishuAgentBotBinding): FeishuAgentBotNextCommands {
  const agentFlags = `--workspace-id ${binding.workspaceId} --agent ${binding.agentId}`;
  const integrationFlags = `--workspace-id ${binding.workspaceId} --integration ${binding.id}`;
  const smokeHarness = buildFeishuSmokeHarnessSummary({
    workspaceId: binding.workspaceId,
    integrationId: binding.id,
  });
  return {
    healthCheck: `dofe-agent integrations feishu health-check ${agentFlags} --strict --json`,
    botReadiness: `dofe-agent integrations feishu agent-bot-readiness ${agentFlags} --strict --require bot --json`,
    dataPlaneReadiness: `dofe-agent integrations feishu agent-bot-readiness ${agentFlags} --strict --require data-plane --json`,
    workerReadiness: `dofe-agent integrations feishu agent-bot-readiness ${agentFlags} --strict --require worker --json`,
    autoProvisionPolicy: `dofe-agent integrations feishu auto-provision-policy ${agentFlags} --bot-added-policy auto_create_channel --first-message-policy auto_create_if_bot_mentioned --unbound-user-mode reply_on_mention --guest-permission-profile channel_context_only --json`,
    agentChannelAccessDisable: `dofe-agent integrations feishu agent-channel-access ${agentFlags} --access disabled --json`,
    agentChannelAccessRestore: `dofe-agent integrations feishu agent-channel-access ${agentFlags} --access enabled --json`,
    channelBindings: `dofe-agent integrations feishu channel-bindings ${integrationFlags} --json`,
    smokeEnv: smokeHarness.prepareEnvCommand,
    checkEnv: smokeHarness.checkEnvCommand,
    strictLiveSmoke: smokeHarness.strictLiveCommand,
    verifyOpenApiEvidence: smokeHarness.verifyEvidenceCommand,
    verifyBotAddedPayload: smokeHarness.verifyBotAddedPayloadCommand,
    smokePlan: `dofe-agent integrations feishu smoke-plan ${integrationFlags} --app-url ${FEISHU_CLI_PLACEHOLDERS.publicAppUrl}`,
    finalEvidence: `dofe-agent integrations feishu evidence ${integrationFlags} --openapi-evidence ${smokeHarness.evidencePath} --bot-added-payload-evidence ${smokeHarness.botAddedPayloadEvidencePath} --strict --require all`,
    bindSecondAgentBot: `dofe-agent integrations feishu bind-agent-bot --workspace-id ${binding.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.secondAgentName} --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --transport websocket_worker --json`,
  };
}
export function buildFeishuAgentBotCliInputFromFlags(input: {
  workspaceId: string;
  flags: Record<string, string | boolean>;
  actorUserId?: string;
  env?: Record<string, string | undefined>;
}): FeishuAgentBotCliInput {
  const agentId = requireNonPlaceholderFeishuAgentBotValue("agent_id", requireStringFlagValue({
    flags: input.flags,
    keys: ["agent", "agent-id", "agent-name"],
    missingCode: "feishu.agent_bot_binding.missing_agent_id",
  }));
  const appId = requireNonPlaceholderFeishuAgentBotValue("app_id", requireStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["app-id", "app_id"],
    envFlagKeys: ["app-id-env", "app_id_env"],
    defaultEnvNames: ["FEISHU_APP_ID", "DOFE_AGENT_FEISHU_APP_ID"],
    missingCode: "feishu.agent_bot_binding.missing_app_id",
    env: input.env,
  }));
  const appSecret = requireNonPlaceholderFeishuAgentBotValue("app_secret", requireStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["app-secret", "app_secret"],
    envFlagKeys: ["app-secret-env", "app_secret_env"],
    defaultEnvNames: ["FEISHU_APP_SECRET", "DOFE_AGENT_FEISHU_APP_SECRET"],
    missingCode: "feishu.agent_bot_binding.missing_app_secret",
    env: input.env,
  }));
  const verificationToken = validateOptionalFeishuAgentBotValue("verification_token", readStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["verification-token", "verification_token"],
    envFlagKeys: ["verification-token-env", "verification_token_env"],
    defaultEnvNames: ["FEISHU_VERIFICATION_TOKEN", "DOFE_AGENT_FEISHU_VERIFICATION_TOKEN"],
    env: input.env,
  }));
  const encryptKey = validateOptionalFeishuAgentBotValue("encrypt_key", readStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["encrypt-key", "encrypt_key"],
    envFlagKeys: ["encrypt-key-env", "encrypt_key_env"],
    defaultEnvNames: ["FEISHU_ENCRYPT_KEY", "DOFE_AGENT_FEISHU_ENCRYPT_KEY"],
    env: input.env,
  }));
  const tenantKey = validateOptionalFeishuAgentBotValue("tenant_key", readStringFlagOrEnv({
    flags: input.flags,
    flagKeys: ["tenant-key", "tenant_key"],
    envFlagKeys: ["tenant-key-env", "tenant_key_env"],
    defaultEnvNames: ["FEISHU_TENANT_KEY", "DOFE_AGENT_FEISHU_TENANT_KEY"],
    env: input.env,
  }));
  return {
    workspaceId: input.workspaceId,
    agentId,
    displayName: getStringFlag(input.flags, "name") ?? getStringFlag(input.flags, "display-name"),
    transportMode: getStringFlag(input.flags, "transport") ?? getStringFlag(input.flags, "mode") ?? "http_webhook",
    appId,
    appSecret,
    verificationToken,
    encryptKey,
    tenantKey,
    channelAutoProvisioning: buildFeishuAgentBotChannelAutoProvisioningFromFlags(input.flags),
    externalGuestPolicy: buildFeishuAgentBotExternalGuestPolicyFromFlags(input.flags),
    actorUserId: input.actorUserId,
  };
}
export function buildFeishuAgentBotPolicyCliInputFromFlags(input: {
  workspaceId: string;
  integrationId?: string;
  flags: Record<string, string | boolean>;
  actorUserId?: string;
}): FeishuAgentBotCliInput {
  return {
    workspaceId: input.workspaceId,
    integrationId: normalizeOptionalText(input.integrationId),
    agentId: getStringFlag(input.flags, "agent")
      ?? getStringFlag(input.flags, "agent-id")
      ?? getStringFlag(input.flags, "agent-name"),
    channelAutoProvisioning: buildFeishuAgentBotChannelAutoProvisioningFromFlags(input.flags),
    externalGuestPolicy: buildFeishuAgentBotExternalGuestPolicyFromFlags(input.flags),
    actorUserId: input.actorUserId,
  };
}
export function buildFeishuAgentChannelAccessCliInputFromFlags(input: {
  workspaceId: string;
  integrationId?: string;
  flags: Record<string, string | boolean>;
  actorUserId?: string;
}): FeishuAgentChannelAccessCliInput {
  return {
    workspaceId: input.workspaceId,
    integrationId: normalizeOptionalText(input.integrationId),
    agentId: getStringFlag(input.flags, "agent")
      ?? getStringFlag(input.flags, "agent-id")
      ?? getStringFlag(input.flags, "agent-name"),
    channelMemberAccess: readRequiredFeishuAgentChannelAccessFlag(input.flags),
    actorUserId: input.actorUserId,
  };
}
export function buildFeishuAgentBotChannelAutoProvisioningFromFlags(
  flags: Record<string, string | boolean>,
): FeishuAgentBotChannelAutoProvisioningInput | undefined {
  const botAdded = readFeishuPolicyFlag(flags, ["bot-added-policy", "bot_added_policy"], [
    "auto_create_channel",
    "pending_admin_review",
    "disabled",
  ], "feishu.agent_bot_binding.invalid_channel_auto_provisioning_policy");
  const firstMessage = readFeishuPolicyFlag(flags, ["first-message-policy", "first_message_policy"], [
    "auto_create_if_bot_mentioned",
    "pending_admin_review",
    "reply_with_setup_card",
    "disabled",
  ], "feishu.agent_bot_binding.invalid_channel_auto_provisioning_policy");
  const reviewStatus = readFeishuPolicyFlag(flags, ["review-status", "review_status"], [
    "approved",
    "pending_admin_review",
    "needs_identity_binding",
  ], "feishu.agent_bot_binding.invalid_channel_auto_provisioning_policy");
  const policy = {
    ...(botAdded ? { botAdded } : {}),
    ...(firstMessage ? { firstMessage } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
  };
  return Object.keys(policy).length > 0
    ? policy
    : undefined;
}
export function buildFeishuAgentBotExternalGuestPolicyFromFlags(
  flags: Record<string, string | boolean>,
): FeishuAgentBotExternalGuestPolicyInput | undefined {
  const unboundUserMode = readFeishuPolicyFlag(flags, ["unbound-user-mode", "unbound_user_mode"], [
    "ignore",
    "reply_on_mention",
    "reply_all",
    "require_identity",
  ], "feishu.agent_bot_binding.invalid_external_guest_policy");
  const guestPermissionProfile = readFeishuPolicyFlag(flags, ["guest-permission-profile", "guest_permission_profile"], [
    "none",
    "channel_context_only",
    "channel_readonly",
  ], "feishu.agent_bot_binding.invalid_external_guest_policy");
  const requireIdentityFor = readFeishuPolicyListFlag(flags, ["require-identity-for", "require_identity_for"]);
  const policy = {
    ...(unboundUserMode ? { unboundUserMode } : {}),
    ...(guestPermissionProfile ? { guestPermissionProfile } : {}),
    ...(requireIdentityFor ? { requireIdentityFor } : {}),
  };
  return Object.keys(policy).length > 0
    ? policy
    : undefined;
}
export function readRequiredFeishuAgentChannelAccessFlag(
  flags: Record<string, string | boolean>,
): FeishuAgentChannelMemberAccess {
  const channelMemberAccess = readFeishuPolicyFlag(flags, [
    "access",
    "channel-member-access",
    "channel_member_access",
  ], ["enabled", "disabled"], "feishu.agent_channel_access.invalid_access");
  if (!channelMemberAccess) {
    throw new Error("feishu.agent_channel_access.missing_access");
  }
  return channelMemberAccess;
}
export function readFeishuPolicyFlag<T extends string>(
  flags: Record<string, string | boolean>,
  keys: string[],
  allowedValues: readonly T[],
  errorCode: string,
): T | undefined {
  const value = readStringFlagByKeys(flags, keys);
  if (!value) {
    return undefined;
  }
  if (allowedValues.includes(value as T)) {
    return value as T;
  }
  throw new Error(errorCode);
}
export function readFeishuPolicyListFlag(
  flags: Record<string, string | boolean>,
  keys: string[],
): string[] | undefined {
  const value = readStringFlagByKeys(flags, keys);
  if (!value) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
export function buildFeishuCliAgentBotErrorReport(error: unknown): FeishuCliErrorReport | undefined {
  const message = error instanceof Error ? error.message : String(error);
  switch (message) {
    case "DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY is required to store Feishu credentials.":
    case "feishu.agent_bot_binding.credential_encryption_key_missing":
      return {
        ok: false,
        errorCode: "feishu.agent_bot_binding.credential_encryption_key_missing",
        errorMessage: "DofeAgent credential encryption key is missing.",
        nextStep: "export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)",
      };
    case "DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.":
    case "feishu.agent_bot_binding.credential_encryption_key_invalid":
      return {
        ok: false,
        errorCode: "feishu.agent_bot_binding.credential_encryption_key_invalid",
        errorMessage: "DofeAgent credential encryption key must be a base64-encoded 32-byte key.",
        nextStep: "export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)",
      };
    case "feishu.agent_bot_binding.duplicate_app_tenant":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "This Feishu App ID and Tenant Key are already connected to an DofeAgent bot binding.",
      };
    case "feishu.agent_bot_binding.duplicate_agent":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "This DofeAgent agent already has an active Feishu bot binding.",
        nextStep: "Disable or rotate the existing agent bot binding instead of creating a second active binding.",
      };
    case "feishu.agent_bot_binding.missing_agent_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent agent id or name is required.",
        nextStep: "Set --agent <agent-id-or-name>.",
      };
    case "feishu.agent_bot_binding.missing_app_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu App ID is required.",
        nextStep: "Set --app-id or --app-id-env FEISHU_APP_ID.",
      };
    case "feishu.agent_bot_binding.missing_app_secret":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu App Secret is required.",
        nextStep: "Set --app-secret or --app-secret-env FEISHU_APP_SECRET.",
      };
    case "feishu.agent_bot_binding.missing_verification_token":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu Verification Token is required for EventCallback mode.",
        nextStep: "Use default WebSocket worker mode or set --verification-token.",
      };
    case "feishu.agent_bot_binding.invalid_transport_mode":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu agent bot transport must be http_webhook or websocket_worker.",
      };
    case "feishu.agent_bot_binding.invalid_channel_auto_provisioning_policy":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu agent bot auto-provisioning policy is invalid.",
        nextStep: "Use --bot-added-policy auto_create_channel|pending_admin_review|disabled and --first-message-policy auto_create_if_bot_mentioned|pending_admin_review|reply_with_setup_card|disabled.",
      };
    case "feishu.agent_bot_binding.invalid_external_guest_policy":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu agent bot external guest policy is invalid.",
        nextStep: "Use --unbound-user-mode ignore|reply_on_mention|reply_all|require_identity and --guest-permission-profile none|channel_context_only|channel_readonly.",
      };
    case "feishu.agent_bot_binding.not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu agent bot binding was not found.",
        nextStep: "Pass --agent <agent-id-or-name> or --integration <integration-id> for an existing agent bot binding.",
      };
    case "feishu.agent_channel_access.missing_access":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Agent channel-member access value is required.",
        nextStep: "Pass --access enabled or --access disabled.",
      };
    case "feishu.agent_channel_access.invalid_access":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Agent channel-member access must be enabled or disabled.",
        nextStep: "Use --access enabled to restore replies or --access disabled for the no-reply smoke step.",
      };
    case "feishu.agent_channel_access.missing_target":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Agent channel-member access target is required.",
        nextStep: "Pass --agent <agent-id-or-name> or --integration <agent-bot-integration-id>.",
      };
    case "feishu.agent_channel_access.integration_not_agent_bot":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "The selected Feishu integration is not an agent-scoped bot binding.",
        nextStep: "Pass an agent bot binding id or use --agent <agent-id-or-name>.",
      };
    case "feishu.agent_channel_access.agent_not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent agent was not found after updating channel-member access.",
        nextStep: "Check --workspace-id and --agent.",
      };
  }

  if (message.startsWith("feishu.cli.missing_env_value:")) {
    const envName = message.slice("feishu.cli.missing_env_value:".length);
    return {
      ok: false,
      errorCode: "feishu.agent_bot_binding.missing_env_value",
      errorMessage: `Environment variable ${envName} is not set.`,
      nextStep: `Set ${envName} or choose a different --*-env variable.`,
    };
  }
  if (message.startsWith("feishu.agent_bot_binding.placeholder_value:")) {
    const fieldName = message.slice("feishu.agent_bot_binding.placeholder_value:".length);
    return {
      ok: false,
      errorCode: "feishu.agent_bot_binding.placeholder_value",
      errorMessage: `Feishu agent bot input contains a placeholder value for ${fieldName}.`,
      nextStep: `Replace ${fieldName} with the real value from Feishu Open Platform before binding the bot.`,
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_file_line:")) {
    return {
      ok: false,
      errorCode: "feishu.agent_bot_binding.invalid_env_file",
      errorMessage: "Feishu agent bot env file contains a line that is not KEY=value.",
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_name:")) {
    return {
      ok: false,
      errorCode: "feishu.agent_bot_binding.invalid_env_file",
      errorMessage: "Feishu agent bot env file contains an invalid environment variable name.",
    };
  }
  if (message.startsWith("feishu.cli.invalid_env_file_quote:")) {
    return {
      ok: false,
      errorCode: "feishu.agent_bot_binding.invalid_env_file",
      errorMessage: "Feishu agent bot env file contains an unterminated quoted value.",
    };
  }

  return undefined;
}
export function parseFeishuAgentBotCliTransportMode(value: string | undefined): ExternalIntegrationTransportMode {
  try {
    return parseFeishuCliTransportMode(value ?? "http_webhook");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "feishu.create.invalid_transport_mode") {
      throw new Error("feishu.agent_bot_binding.invalid_transport_mode");
    }
    throw error;
  }
}
