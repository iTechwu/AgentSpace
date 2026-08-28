import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeishuExternalGuestActor,
  evaluateFeishuExternalGuestIdentityRequirement,
  readFeishuExternalParticipantPolicy,
  resolveFeishuExternalGuestDisplayName,
  type FeishuExternalParticipantPolicy,
} from "../external-guests.ts";

const baseIntegration = {
  id: "integration-1",
  workspaceId: "workspace-1",
  provider: "feishu" as const,
  displayName: "Codex Feishu Bot",
  status: "active" as const,
  transportMode: "websocket_worker" as const,
  agentId: "Codex",
  appId: "cli_codex_bot",
  encryptedCredentialsJson: "{}",
  capabilitiesJson: "{}",
  scopesJson: "[]",
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
};

test("external guest identity requirements keep writes and approvals hard-gated", () => {
  const relaxedPolicy: Pick<FeishuExternalParticipantPolicy, "requireIdentityFor"> = {
    requireIdentityFor: [],
  };

  assert.deepEqual(evaluateFeishuExternalGuestIdentityRequirement({
    policy: relaxedPolicy,
    action: "writes",
  }), {
    decision: "require_identity",
    action: "writes",
    policy: relaxedPolicy,
    reasonCode: "feishu_external_guest_write_identity_required",
    policyConfigured: false,
  });
  assert.equal(evaluateFeishuExternalGuestIdentityRequirement({
    policy: relaxedPolicy,
    action: "approvals",
  }).decision, "require_identity");
});

test("external guest identity requirements honor configurable private resource gates", () => {
  const policy: Pick<FeishuExternalParticipantPolicy, "requireIdentityFor"> = {
    requireIdentityFor: ["private_resources"],
  };

  assert.deepEqual(evaluateFeishuExternalGuestIdentityRequirement({
    policy,
    action: "private_resources",
  }), {
    decision: "require_identity",
    action: "private_resources",
    policy,
    reasonCode: "feishu_external_guest_private_resource_identity_required",
    policyConfigured: true,
  });
  assert.deepEqual(evaluateFeishuExternalGuestIdentityRequirement({
    policy,
    action: "runtime_sensitive_tools",
  }), {
    decision: "allow",
    action: "runtime_sensitive_tools",
    policy,
    reasonCode: "feishu_external_guest_identity_not_required",
    policyConfigured: false,
  });
});

test("external guest policy preserves explicit empty identity requirements", () => {
  const policy = readFeishuExternalParticipantPolicy({
    ...baseIntegration,
    configJson: JSON.stringify({
      externalGuestPolicy: {
        requireIdentityFor: [],
      },
    }),
  });

  assert.deepEqual(policy, {
    unboundUserMode: "reply_on_mention",
    guestPermissionProfile: "channel_context_only",
    requireIdentityFor: [],
  });
  assert.equal(evaluateFeishuExternalGuestIdentityRequirement({
    policy,
    action: "writes",
  }).decision, "require_identity");
  assert.equal(evaluateFeishuExternalGuestIdentityRequirement({
    policy,
    action: "private_resources",
  }).decision, "allow");
});

test("external guest fallback uses a non-reversible identifier instead of a generic guest label", () => {
  const actor = buildFeishuExternalGuestActor({
    workspaceId: "workspace-1",
    externalUserId: "ou_external_user",
    sourceChatId: "oc_group",
    permissionProfile: "channel_context_only",
  });

  assert.match(resolveFeishuExternalGuestDisplayName(actor), /^Feishu user #[a-f0-9]{8}$/);
  assert.equal(resolveFeishuExternalGuestDisplayName({
    ...actor,
    providerDisplayName: "Mina",
  }), "Mina");
});
