// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  listExternalChannelBindingsSync,
  listExternalIntegrationsSync,
  readExternalChannelBindingByExternalChatSync,
  readExternalIntegrationSync,
  readExternalResourceBindingByKeySync,
  readExternalUserBindingByExternalUserSync,
  readStoredChannelSync,
  readWorkspaceMembershipSync,
  upsertExternalChannelBindingSync,
  upsertExternalResourceBindingSync,
  upsertExternalUserBindingSync,
  type ExternalChannelBindingRecord,
  type ExternalBindingStatus,
  type ExternalIntegrationRecord
} from "@dofe-agent/db";
import { FEISHU_PROVIDER_ID, resolveFeishuResourceDescriptorForType, upsertFeishuExternalChannelDocumentSync, upsertFeishuExternalDataTableSync, validateFeishuResourceDescriptorForBinding, validateFeishuResourceBindingScopes } from "@dofe-agent/services/integrations";
import { tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services/workspace";
import { isFeishuCliPlaceholderValue, normalizeOptionalText, requireActiveFeishuCliIntegration, requireNonEmpty, requireNonPlaceholderFeishuBindingValue, validateOptionalFeishuBindingValue } from "./cli-shared.ts";
import { buildFeishuCliExternalReference, readJsonRecord, readStringMetadata } from "./evidence.ts";
import type { FeishuBindingCliResult, FeishuChannelBindingCliItem, FeishuChannelBindingsCliReport, FeishuCliErrorReport } from "./types.ts";

export function createFeishuChannelBindingForCli(
  input: {
    workspaceId: string;
    integrationId: string;
    channelName: string;
    externalChatId: string;
    externalChatType?: string;
    externalChatName?: string;
    createdByUserId?: string;
  },
  deps: {
    readIntegration?: typeof readExternalIntegrationSync;
    readChannel?: typeof readStoredChannelSync;
    readBindingByExternalChat?: typeof readExternalChannelBindingByExternalChatSync;
    upsertBinding?: typeof upsertExternalChannelBindingSync;
    auditRecorder?: typeof tryRecordWorkspaceAuditEventSync;
  } = {},
): FeishuBindingCliResult {
  const readIntegration = deps.readIntegration ?? readExternalIntegrationSync;
  const readChannel = deps.readChannel ?? readStoredChannelSync;
  const readBindingByExternalChat = deps.readBindingByExternalChat ?? readExternalChannelBindingByExternalChatSync;
  const upsertBinding = deps.upsertBinding ?? upsertExternalChannelBindingSync;
  const auditRecorder = deps.auditRecorder ?? tryRecordWorkspaceAuditEventSync;
  const integrationId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.integrationId, "feishu.integration.missing_integration_id"),
    "feishu.integration.placeholder_value",
  );
  const channelName = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.channelName, "feishu.bind_channel.missing_channel"),
    "feishu.bind_channel.placeholder_value",
  );
  const externalChatId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.externalChatId, "feishu.bind_channel.missing_chat_id"),
    "feishu.bind_channel.placeholder_value",
  );
  const integration = requireActiveFeishuCliIntegration({
    workspaceId: input.workspaceId,
    integrationId,
    readIntegration,
  });
  if (!readChannel(channelName, input.workspaceId)) {
    throw new Error("feishu.bind_channel.channel_not_found");
  }
  const existingExternalChatBinding = readBindingByExternalChat({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    externalChatId,
  });
  if (existingExternalChatBinding && existingExternalChatBinding.channelName !== channelName) {
    throw new Error("feishu.bind_channel.external_chat_taken");
  }

  const binding = upsertBinding({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    channelName,
    externalChatId,
    externalChatType: normalizeOptionalText(input.externalChatType),
    externalChatName: normalizeOptionalText(input.externalChatName),
    status: "active",
    syncMode: "mirror",
    createdByUserId: normalizeOptionalText(input.createdByUserId),
  });
  const auditRecorded = auditRecorder({
    workspaceId: input.workspaceId,
    title: "Feishu channel binding saved from CLI",
    note: `Feishu CLI mapped DofeAgent channel "${channelName}" to a Feishu chat.`,
    code: "workspace.external_channel_binding_upserted",
    data: {
      actorType: "cli",
      resourceType: "external_channel_binding",
      resourceId: binding.id,
      provider: FEISHU_PROVIDER_ID,
      integrationId: integration.id,
      channelName: binding.channelName,
      externalIdRedacted: true,
    },
  });

  return {
    ok: true,
    kind: "channel",
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    bindingId: binding.id,
    status: binding.status,
    externalIdRedacted: true,
    auditRecorded,
    channelName: binding.channelName,
  };
}
export function buildFeishuChannelBindingsCliReport(input: {
  workspaceId: string;
  integrationId?: string;
  status?: ExternalBindingStatus;
  integrations?: ExternalIntegrationRecord[];
  channelBindingsByIntegrationId?: Record<string, ExternalChannelBindingRecord[]>;
}): FeishuChannelBindingsCliReport {
  const integrations = (input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  })).filter((integration) => !input.integrationId || integration.id === input.integrationId);
  const bindingsByIntegrationId = new Map<string, ExternalChannelBindingRecord[]>();
  for (const integration of integrations) {
    bindingsByIntegrationId.set(
      integration.id,
      input.channelBindingsByIntegrationId?.[integration.id] ?? listExternalChannelBindingsSync({
        workspaceId: input.workspaceId,
        integrationId: integration.id,
        status: input.status,
      }),
    );
  }
  const bindings = integrations.flatMap((integration) =>
    (bindingsByIntegrationId.get(integration.id) ?? []).map((binding) =>
      buildFeishuChannelBindingCliItem({
        integration,
        binding,
      })
    )
  );

  return {
    ok: true,
    workspaceId: input.workspaceId,
    ...(input.integrationId ? { integrationId: input.integrationId } : {}),
    integrationCount: integrations.length,
    bindingCount: bindings.length,
    activeBindingCount: bindings.filter((binding) => binding.status === "active").length,
    externalIdsRedacted: true,
    integrations: integrations.map((integration) => {
      const channelBindings = bindingsByIntegrationId.get(integration.id) ?? [];
      return {
        integrationId: integration.id,
        displayName: integration.displayName,
        ...(integration.agentId ? { agentId: integration.agentId } : {}),
        status: integration.status,
        bindingCount: channelBindings.length,
        activeBindingCount: channelBindings.filter((binding) => binding.status === "active").length,
      };
    }),
    bindings,
  };
}
export function buildFeishuChannelBindingCliItem(input: {
  integration: ExternalIntegrationRecord;
  binding: ExternalChannelBindingRecord;
}): FeishuChannelBindingCliItem {
  const metadata = readJsonRecord(input.binding.metadataJson) ?? {};
  const provisionSource = readStringMetadata(metadata.provisionSource);
  const reviewStatus = readStringMetadata(metadata.reviewStatus);
  const agentId = readStringMetadata(metadata.agentId) ?? input.integration.agentId;
  const botBindingId = readStringMetadata(metadata.botBindingId);
  const linkedFromBindingId = readStringMetadata(metadata.linkedFromBindingId);
  const linkedFromAgentId = readStringMetadata(metadata.linkedFromAgentId);
  const linkedFromBotBindingId = readStringMetadata(metadata.linkedFromBotBindingId);
  return {
    bindingId: input.binding.id,
    integrationId: input.integration.id,
    integrationDisplayName: input.integration.displayName,
    ...(input.integration.agentId ? { integrationAgentId: input.integration.agentId } : {}),
    channelName: input.binding.channelName,
    externalChatReference: buildFeishuCliExternalReference("chat", input.binding.externalChatId),
    externalChatIdRedacted: true,
    ...(input.binding.externalChatType ? { externalChatType: input.binding.externalChatType } : {}),
    ...(input.binding.externalChatName ? { externalChatName: input.binding.externalChatName } : {}),
    status: input.binding.status,
    syncMode: input.binding.syncMode,
    ...(provisionSource ? { provisionSource } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(agentId ? { agentId } : {}),
    ...(botBindingId ? { botBindingId } : {}),
    ...(linkedFromBindingId ? { linkedFromBindingId } : {}),
    ...(linkedFromAgentId ? { linkedFromAgentId } : {}),
    ...(linkedFromBotBindingId ? { linkedFromBotBindingId } : {}),
    createdAt: input.binding.createdAt,
    updatedAt: input.binding.updatedAt,
  };
}
export function createFeishuUserBindingForCli(
  input: {
    workspaceId: string;
    integrationId: string;
    userId: string;
    externalUserId: string;
    externalUnionId?: string;
    externalOpenId?: string;
    externalEmail?: string;
    displayName?: string;
  },
  deps: {
    readIntegration?: typeof readExternalIntegrationSync;
    readMembership?: typeof readWorkspaceMembershipSync;
    readBindingByExternalUser?: typeof readExternalUserBindingByExternalUserSync;
    upsertBinding?: typeof upsertExternalUserBindingSync;
    auditRecorder?: typeof tryRecordWorkspaceAuditEventSync;
  } = {},
): FeishuBindingCliResult {
  const readIntegration = deps.readIntegration ?? readExternalIntegrationSync;
  const readMembership = deps.readMembership ?? readWorkspaceMembershipSync;
  const readBindingByExternalUser = deps.readBindingByExternalUser ?? readExternalUserBindingByExternalUserSync;
  const upsertBinding = deps.upsertBinding ?? upsertExternalUserBindingSync;
  const auditRecorder = deps.auditRecorder ?? tryRecordWorkspaceAuditEventSync;
  const integrationId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.integrationId, "feishu.integration.missing_integration_id"),
    "feishu.integration.placeholder_value",
  );
  const userId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.userId, "feishu.bind_user.missing_user_id"),
    "feishu.bind_user.placeholder_value",
  );
  const externalUserId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.externalUserId, "feishu.bind_user.missing_open_id"),
    "feishu.bind_user.placeholder_value",
  );
  const externalUnionId = validateOptionalFeishuBindingValue(
    input.externalUnionId,
    "feishu.bind_user.placeholder_value",
  );
  const externalOpenId = validateOptionalFeishuBindingValue(
    input.externalOpenId,
    "feishu.bind_user.placeholder_value",
  );
  const externalEmail = validateOptionalFeishuBindingValue(
    input.externalEmail,
    "feishu.bind_user.placeholder_value",
  );
  const integration = requireActiveFeishuCliIntegration({
    workspaceId: input.workspaceId,
    integrationId,
    readIntegration,
  });
  if (!readMembership(input.workspaceId, userId)) {
    throw new Error("feishu.bind_user.user_not_found");
  }
  const existingExternalBinding = readBindingByExternalUser({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    externalUserId,
  });
  if (existingExternalBinding && existingExternalBinding.userId !== userId) {
    throw new Error("feishu.bind_user.external_user_taken");
  }

  const binding = upsertBinding({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    userId,
    externalUserId,
    externalUnionId,
    externalOpenId,
    externalEmail,
    displayName: normalizeOptionalText(input.displayName),
    status: "active",
  });
  const auditRecorded = auditRecorder({
    workspaceId: input.workspaceId,
    title: "Feishu user binding saved from CLI",
    note: `Feishu CLI mapped DofeAgent user "${userId}" to a Feishu user.`,
    code: "workspace.external_user_binding_upserted",
    data: {
      actorType: "cli",
      resourceType: "external_user_binding",
      resourceId: binding.id,
      provider: FEISHU_PROVIDER_ID,
      integrationId: integration.id,
      userId: binding.userId,
      externalIdRedacted: true,
    },
  });

  return {
    ok: true,
    kind: "user",
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    bindingId: binding.id,
    status: binding.status,
    externalIdRedacted: true,
    auditRecorded,
    userId: binding.userId,
  };
}
export function createFeishuResourceBindingForCli(
  input: {
    workspaceId: string;
    integrationId: string;
    providerResourceType: string;
    resourceUrlOrToken: string;
    dofeAgentResourceType: string;
    dofeAgentResourceId?: string;
    channelName?: string;
    displayName?: string;
    allowWrite?: boolean;
    guestReadable?: boolean;
    createdByUserId?: string;
    createdBy?: string;
  },
  deps: {
    readIntegration?: typeof readExternalIntegrationSync;
    readChannel?: typeof readStoredChannelSync;
    resolveResourceDescriptor?: typeof resolveFeishuResourceDescriptorForType;
    syncChannelDocument?: typeof upsertFeishuExternalChannelDocumentSync;
    syncDataTable?: typeof upsertFeishuExternalDataTableSync;
    readBindingByResourceKey?: typeof readExternalResourceBindingByKeySync;
    upsertBinding?: typeof upsertExternalResourceBindingSync;
    auditRecorder?: typeof tryRecordWorkspaceAuditEventSync;
  } = {},
): FeishuBindingCliResult {
  const readIntegration = deps.readIntegration ?? readExternalIntegrationSync;
  const readChannel = deps.readChannel ?? readStoredChannelSync;
  const resolveResourceDescriptor = deps.resolveResourceDescriptor ?? resolveFeishuResourceDescriptorForType;
  const syncChannelDocument = deps.syncChannelDocument ?? upsertFeishuExternalChannelDocumentSync;
  const syncDataTable = deps.syncDataTable ?? upsertFeishuExternalDataTableSync;
  const readBindingByResourceKey = deps.readBindingByResourceKey ?? readExternalResourceBindingByKeySync;
  const upsertBinding = deps.upsertBinding ?? upsertExternalResourceBindingSync;
  const auditRecorder = deps.auditRecorder ?? tryRecordWorkspaceAuditEventSync;
  const integrationId = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.integrationId, "feishu.integration.missing_integration_id"),
    "feishu.integration.placeholder_value",
  );
  const providerResourceType = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.providerResourceType, "feishu.bind_resource.missing_type"),
    "feishu.bind_resource.placeholder_value",
  );
  const resourceUrlOrToken = requireNonPlaceholderFeishuBindingValue(
    requireNonEmpty(input.resourceUrlOrToken, "feishu.bind_resource.missing_resource"),
    "feishu.bind_resource.placeholder_value",
  );
  const integration = requireActiveFeishuCliIntegration({
    workspaceId: input.workspaceId,
    integrationId,
    readIntegration,
  });
  const descriptor = resolveResourceDescriptor(providerResourceType, resourceUrlOrToken);
  if (!descriptor) {
    throw new Error("feishu.bind_resource.invalid_resource");
  }
  const descriptorValidation = validateFeishuResourceDescriptorForBinding(descriptor);
  if (!descriptorValidation.ok) {
    throw new Error(descriptorValidation.errorCode.replace("feishu.resource_binding.", "feishu.bind_resource."));
  }
  const scopeValidation = validateFeishuResourceBindingScopes({
    providerResourceType: descriptor.providerResourceType,
    scopesJson: integration.scopesJson,
  });
  if (!scopeValidation.ok) {
    throw new Error("feishu.bind_resource.scope_missing");
  }

  const dofeAgentResourceType = requireNonEmpty(
    input.dofeAgentResourceType,
    "feishu.bind_resource.missing_dofe_agent_type",
  );
  if (isFeishuCliPlaceholderValue(dofeAgentResourceType)) {
    throw new Error("feishu.bind_resource.placeholder_value");
  }
  let dofeAgentResourceId = validateOptionalFeishuBindingValue(
    input.dofeAgentResourceId,
    "feishu.bind_resource.placeholder_value",
  ) ?? "";
  let channelName = validateOptionalFeishuBindingValue(
    input.channelName,
    "feishu.bind_resource.placeholder_value",
  );
  const displayName = normalizeOptionalText(input.displayName);
  if (
    !dofeAgentResourceId &&
    dofeAgentResourceType !== "channel_document" &&
    dofeAgentResourceType !== "data_table"
  ) {
    throw new Error("feishu.bind_resource.missing_dofe_agent_id");
  }
  if (channelName && !readChannel(channelName, input.workspaceId)) {
    throw new Error("feishu.bind_resource.channel_not_found");
  }
  const existingResourceBinding = readBindingByResourceKey({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    providerResourceType: descriptor.providerResourceType,
    providerResourceToken: descriptor.providerResourceToken,
  });
  if (existingResourceBinding && existingResourceBinding.status !== "archived") {
    if (
      existingResourceBinding.dofeAgentResourceType !== dofeAgentResourceType ||
      (dofeAgentResourceId && existingResourceBinding.dofeAgentResourceId !== dofeAgentResourceId) ||
      (channelName && (existingResourceBinding.channelName ?? "") !== channelName)
    ) {
      throw new Error("feishu.bind_resource.external_resource_taken");
    }
    dofeAgentResourceId = existingResourceBinding.dofeAgentResourceId;
    channelName = channelName ?? existingResourceBinding.channelName;
  }

  let metadataJson: Record<string, unknown> = descriptor.metadata ?? {};
  if (dofeAgentResourceType === "channel_document") {
    const syncedDocument = syncChannelDocument({
      channelName,
      dofeAgentResourceId,
      providerResourceType: descriptor.providerResourceType,
      providerResourceToken: descriptor.providerResourceToken,
      providerResourceUrl: descriptor.providerResourceUrl,
      title: displayName,
      createdBy: normalizeOptionalText(input.createdBy) ?? "DofeAgent CLI",
      createdByType: "human",
    }, input.workspaceId);
    dofeAgentResourceId = syncedDocument.document.id;
    channelName = syncedDocument.document.channelName;
    metadataJson = {
      ...metadataJson,
      dofeAgentSync: {
        channelDocumentId: syncedDocument.document.id,
        channelName: syncedDocument.document.channelName,
        created: syncedDocument.created,
      },
    };
  } else if (dofeAgentResourceType === "data_table") {
    const syncedTable = syncDataTable({
      channelName,
      dofeAgentResourceId,
      providerResourceType: descriptor.providerResourceType,
      providerResourceToken: descriptor.providerResourceToken,
      providerResourceUrl: descriptor.providerResourceUrl,
      title: displayName,
      metadata: descriptor.metadata ?? {},
      createdBy: normalizeOptionalText(input.createdBy) ?? "DofeAgent CLI",
    }, input.workspaceId);
    dofeAgentResourceId = syncedTable.table.id;
    channelName = syncedTable.table.channelName ?? channelName;
    metadataJson = {
      ...metadataJson,
      dofeAgentSync: {
        dataTableId: syncedTable.table.id,
        channelName: syncedTable.table.channelName,
        created: syncedTable.created,
      },
    };
  }

  const binding = upsertBinding({
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    providerResourceType: descriptor.providerResourceType,
    providerResourceToken: descriptor.providerResourceToken,
    providerResourceUrl: descriptor.providerResourceUrl,
    dofeAgentResourceType,
    dofeAgentResourceId,
    channelName,
    displayName,
    status: "active",
    permissionsJson: buildFeishuCliResourceBindingPermissions({
      allowWrite: input.allowWrite,
      guestReadable: input.guestReadable,
    }),
    metadataJson,
    createdByUserId: normalizeOptionalText(input.createdByUserId),
  });
  const auditRecorded = auditRecorder({
    workspaceId: input.workspaceId,
    title: "Feishu resource binding saved from CLI",
    note: `Feishu CLI mapped a Feishu ${descriptor.providerResourceType} resource to DofeAgent.`,
    code: "workspace.external_resource_binding_upserted",
    data: {
      actorType: "cli",
      resourceType: "external_resource_binding",
      resourceId: binding.id,
      provider: FEISHU_PROVIDER_ID,
      integrationId: integration.id,
      providerResourceType: binding.providerResourceType,
      dofeAgentResourceType: binding.dofeAgentResourceType,
      dofeAgentResourceId: binding.dofeAgentResourceId,
      channelName: binding.channelName,
      writeAllowed: input.allowWrite === true,
      guestReadable: input.guestReadable === true,
      externalIdRedacted: true,
    },
  });

  return {
    ok: true,
    kind: "resource",
    workspaceId: input.workspaceId,
    integrationId: integration.id,
    bindingId: binding.id,
    status: binding.status,
    externalIdRedacted: true,
    auditRecorded,
    channelName: binding.channelName,
    providerResourceType: binding.providerResourceType,
    dofeAgentResourceType: binding.dofeAgentResourceType,
    dofeAgentResourceId: binding.dofeAgentResourceId,
  };
}
export function buildFeishuCliResourceBindingPermissions(input: {
  allowWrite?: boolean;
  guestReadable?: boolean;
}): Record<string, boolean> | undefined {
  const permissions: Record<string, boolean> = {};
  if (input.allowWrite) {
    permissions.canRead = true;
    permissions.canWrite = true;
  }
  if (input.guestReadable) {
    permissions.canRead = true;
    permissions.externalGuestReadable = true;
  }
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}
export function buildFeishuCliBindingErrorReport(error: unknown): FeishuCliErrorReport | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("feishu.cli.missing_")) {
    const flagName = message.slice("feishu.cli.missing_".length).replace(/_/g, "-");
    return {
      ok: false,
      errorCode: message,
      errorMessage: `Missing required Feishu binding flag --${flagName}.`,
      nextStep: `Rerun the bind command with --${flagName}.`,
    };
  }

  switch (message) {
    case "feishu.integration.missing_integration_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu integration id is required.",
        nextStep: "Pass --integration <id> or set DOFE_AGENT_FEISHU_INTEGRATION_ID.",
      };
    case "feishu.integration.not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu integration was not found in this workspace.",
        nextStep: "Run dofe-agent integrations feishu create or check --workspace-id / --integration.",
      };
    case "feishu.integration.not_active":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu integration is not active.",
        nextStep: "Resume the Feishu integration before creating bindings.",
      };
    case "feishu.integration.placeholder_value":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu integration id still contains a placeholder value.",
        nextStep: "Replace the generated CHANGE_ME_* placeholder with an existing Feishu integration id before rerunning the binding command.",
      };
    case "feishu.bindings.invalid_status":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu binding status filter is invalid.",
        nextStep: "Pass --status active, --status disabled, or --status archived.",
      };
    case "feishu.bind_channel.placeholder_value":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu channel binding input contains a placeholder value.",
        nextStep: "Replace the generated CHANGE_ME_* placeholders with a real DofeAgent channel and Feishu chat id.",
      };
    case "feishu.bind_channel.missing_channel":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent channel name is required.",
        nextStep: "Pass --channel <channel-name>.",
      };
    case "feishu.bind_channel.missing_chat_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu chat id is required.",
        nextStep: "Pass --chat-id <feishu-chat-id> from an unbound event suggestion.",
      };
    case "feishu.bind_channel.channel_not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent channel was not found.",
        nextStep: "Create the DofeAgent channel first or pass a different --channel value.",
      };
    case "feishu.bind_channel.external_chat_taken":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "This Feishu chat is already mapped to another DofeAgent channel.",
        nextStep: "Have a workspace admin review or revoke the existing Feishu channel binding before retrying.",
      };
    case "feishu.bind_user.missing_user_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent user id is required.",
        nextStep: "Pass --user-id <dofe-agent-user-id>.",
      };
    case "feishu.bind_user.missing_open_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu Open ID is required.",
        nextStep: "Pass --open-id <feishu-open-id> from an unbound event suggestion.",
      };
    case "feishu.bind_user.user_not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent workspace user was not found.",
        nextStep: "Invite the user to the DofeAgent workspace before binding their Feishu identity.",
      };
    case "feishu.bind_user.external_user_taken":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "This Feishu Open ID is already bound to another DofeAgent user.",
        nextStep: "Have a workspace admin review or revoke the existing Feishu user binding before retrying.",
      };
    case "feishu.bind_user.placeholder_value":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu user binding input contains a placeholder value.",
        nextStep: "Replace the generated CHANGE_ME_* placeholders with a real DofeAgent user id and Feishu Open ID.",
      };
    case "feishu.bind_resource.missing_type":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu resource type is required.",
        nextStep: "Pass --type doc|sheet|base|base_table|base_view.",
      };
    case "feishu.bind_resource.missing_resource":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu resource URL or token is required.",
        nextStep: "Pass --resource <doc-url|sheet-url|base-table-url-with-app-token>.",
      };
    case "feishu.bind_resource.invalid_resource":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu resource URL or token could not be recognized.",
        nextStep: "Use a supported Feishu Doc, Sheet, Base app/table, or Base view URL/token.",
      };
    case "feishu.bind_resource.base_app_token_missing":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu Base table/view binding requires a Base app token.",
        nextStep: "Pass --resource <base-table-url-with-app-token>; a raw table/view id is not enough for DofeAgent data-plane governance.",
      };
    case "feishu.bind_resource.base_table_id_missing":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu Base view binding requires table context.",
        nextStep: "Pass a Base view URL that includes both table=... and view=....",
      };
    case "feishu.bind_resource.scope_missing":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu integration is missing the Docs / Sheets / Base scopes required for this resource binding.",
        nextStep: "Enable the required Feishu Open Platform scopes, install/publish the app, run health-check, then rerun bind-resource.",
      };
    case "feishu.bind_resource.placeholder_value":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "Feishu resource binding input contains a placeholder value.",
        nextStep: "Replace the generated CHANGE_ME_* placeholders with a real Feishu resource URL/token and DofeAgent target.",
      };
    case "feishu.bind_resource.missing_dofe_agent_type":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent resource type is required.",
        nextStep: "Pass --dofe-agent-type channel_document|data_table|knowledge_page.",
      };
    case "feishu.bind_resource.missing_dofe_agent_id":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent resource id is required for this resource type.",
        nextStep: "Pass --dofe-agent-id <id>, or use channel_document/data_table with --channel to let DofeAgent create the local resource.",
      };
    case "feishu.bind_resource.channel_not_found":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "DofeAgent channel for the resource binding was not found.",
        nextStep: "Create the DofeAgent channel first or pass a different --channel value.",
      };
    case "feishu.bind_resource.external_resource_taken":
      return {
        ok: false,
        errorCode: message,
        errorMessage: "This Feishu resource is already bound to another DofeAgent resource.",
        nextStep: "Have a workspace admin review or archive the existing Feishu resource binding before retrying.",
      };
  }

  return undefined;
}
export function parseFeishuBindingStatusFlag(value: string | undefined): ExternalBindingStatus | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized === "active" || normalized === "disabled" || normalized === "archived") {
    return normalized;
  }
  throw new Error("feishu.bindings.invalid_status");
}
