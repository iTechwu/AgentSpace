// 飞书外部访客策略与交互节点构建。
import {
  listExternalIntegrationsSync,
  listExternalMessageMappingsSync,
} from "@dofe-agent/db";
import {
  sameValue,
} from "../shared/helpers.ts";
import {
  FEISHU_PROVIDER_ID,
} from "../integrations/providers/feishu/constants.ts";
import type {
  PermissionBinding,
  PermissionBuildContext,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  metadataString,
  parseJsonRecord,
  readAllowedString,
  readRecord,
  readStringArray,
  resolveAgentLabel,
} from "./permission-utils.ts";

export function buildFeishuExternalGuestPolicyNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const integrations = listExternalIntegrationsSync({
    workspaceId: context.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    scope: "agent",
    includeDisabled: true,
  }).filter((integration) =>
    context.isManager ||
    context.visibleEmployees.some((employee) => sameValue(employee.name, integration.agentId ?? "")),
  );

  return integrations.map((integration) => {
    const policy = readFeishuExternalGuestPolicyConfig(integration.configJson);
    const subjectId = `feishu:${integration.id}:external_guest`;
    const subjectLabel = `Feishu guests · ${integration.displayName}`;
    const status = integration.status === "disabled" ? "revoked" : "active";
    const policyBinding: PermissionBinding = {
      subjectType: "external_guest",
      subjectId,
      subjectLabel,
      permission: `unbound users: ${policy.unboundUserMode}; ${policy.guestPermissionProfile}`,
      source: "external_guest_policy",
      status: integration.status === "disabled" ? "revoked" : "external",
      editable: false,
      lastChangedAt: integration.updatedAt,
      metadata: {
        provider: FEISHU_PROVIDER_ID,
        integrationId: integration.id,
        agentId: integration.agentId ?? null,
        unboundUserMode: policy.unboundUserMode,
        guestPermissionProfile: policy.guestPermissionProfile,
        requireIdentityFor: policy.requireIdentityFor,
      },
    };
    const agentBinding: PermissionBinding | undefined = integration.agentId
      ? {
          subjectType: "agent",
          subjectId: integration.agentId,
          subjectLabel: resolveAgentLabel(context, integration.agentId),
          permission: "Feishu agent bot guest policy owner",
          source: "external_guest_policy",
          status: integration.status === "disabled" ? "revoked" : "external",
          editable: false,
          lastChangedAt: integration.updatedAt,
          metadata: {
            provider: FEISHU_PROVIDER_ID,
            integrationId: integration.id,
            unboundUserMode: policy.unboundUserMode,
            guestPermissionProfile: policy.guestPermissionProfile,
          },
        }
      : undefined;

    return {
      id: `external-guest-policy:${integration.id}`,
      parentId: context.workspaceNodeId,
      resourceType: "external_identity_policy",
      label: `${integration.displayName} guest policy`,
      status,
      source: "external_guest_policy",
      metadata: {
        provider: FEISHU_PROVIDER_ID,
        integrationId: integration.id,
        agentId: integration.agentId ?? null,
        transportMode: integration.transportMode,
        unboundUserMode: policy.unboundUserMode,
        guestPermissionProfile: policy.guestPermissionProfile,
        requireIdentityFor: policy.requireIdentityFor,
      },
      bindings: [
        policyBinding,
        ...(agentBinding ? [agentBinding] : []),
      ],
      children: buildFeishuExternalGuestInteractionNodes({
        context,
        integrationId: integration.id,
        parentId: `external-guest-policy:${integration.id}`,
        subjectId,
        subjectLabel,
      }),
    } satisfies PermissionTreeNode;
  });
}

function buildFeishuExternalGuestInteractionNodes(input: {
  context: PermissionBuildContext;
  integrationId: string;
  parentId: string;
  subjectId: string;
  subjectLabel: string;
}): PermissionTreeNode[] {
  return listExternalMessageMappingsSync({
    workspaceId: input.context.workspaceId,
    integrationId: input.integrationId,
    direction: "inbound",
    limit: 50,
  })
    .map((mapping) => ({
      mapping,
      metadata: parseJsonRecord(mapping.metadataJson),
    }))
    .filter((entry) => entry.metadata.actorType === "external_guest")
    .slice(0, 5)
    .map((entry) => {
      const channelName = metadataString(entry.metadata, "mappedChannelName");
      const agentId = metadataString(entry.metadata, "agentId");
      const decision = metadataString(entry.metadata, "externalGuestPolicyDecision") ?? "unknown";
      const reasonCode = metadataString(entry.metadata, "externalGuestPolicyReasonCode");
      return {
        id: `external-guest-interaction:${entry.mapping.id}`,
        parentId: input.parentId,
        resourceType: "external_identity_policy",
        label: `Guest interaction · ${channelName ?? agentId ?? entry.mapping.id}`,
        status: decision === "ignore" ? "pending" : "active",
        source: "external_guest_policy",
        metadata: {
          provider: FEISHU_PROVIDER_ID,
          integrationId: input.integrationId,
          channelName: channelName ?? null,
          agentId: agentId ?? null,
          externalChatReference: metadataString(entry.metadata, "externalChatReference") ?? null,
          externalGuestReference: metadataString(entry.metadata, "externalGuestReference") ?? null,
          externalGuestPermissionProfile: metadataString(entry.metadata, "externalGuestPermissionProfile") ?? null,
          decision,
          reasonCode: reasonCode ?? null,
          dispatchStatus: metadataString(entry.metadata, "dispatchStatus") ?? null,
          createdAt: entry.mapping.createdAt,
        },
        bindings: [{
          subjectType: "external_guest",
          subjectId: input.subjectId,
          subjectLabel: input.subjectLabel,
          permission: `guest interaction: ${decision}`,
          source: "external_guest_policy",
          status: "external",
          editable: false,
          lastChangedAt: entry.mapping.createdAt,
          metadata: {
            provider: FEISHU_PROVIDER_ID,
            channelName: channelName ?? null,
            agentId: agentId ?? null,
            externalGuestReference: metadataString(entry.metadata, "externalGuestReference") ?? null,
            reasonCode: reasonCode ?? null,
            dispatchStatus: metadataString(entry.metadata, "dispatchStatus") ?? null,
          },
        }],
      } satisfies PermissionTreeNode;
    });
}

function readFeishuExternalGuestPolicyConfig(configJson: string): {
  unboundUserMode: string;
  guestPermissionProfile: string;
  requireIdentityFor: string[];
} {
  const config = parseJsonRecord(configJson);
  const policy = readRecord(config.externalGuestPolicy) ?? readRecord(config.externalParticipantPolicy);
  return {
    unboundUserMode: readAllowedString(policy?.unboundUserMode, [
      "ignore",
      "reply_on_mention",
      "reply_all",
      "require_identity",
    ], "reply_on_mention"),
    guestPermissionProfile: readAllowedString(policy?.guestPermissionProfile, [
      "none",
      "channel_context_only",
      "channel_readonly",
    ], "channel_context_only"),
    requireIdentityFor: readStringArray(policy?.requireIdentityFor, [
      "writes",
      "approvals",
      "private_resources",
      "runtime_sensitive_tools",
    ]),
  };
}
