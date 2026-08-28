import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput,
} from "../runtime-tools.ts";

test("requires identity for Feishu external guest runtime-sensitive tools by default", () => {
  assert.deepEqual(evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(JSON.stringify({
    externalInput: {
      provider: "feishu",
      externalChatId: "oc_runtime_guest",
      externalMessageId: "om_runtime_guest",
      actor: {
        actorType: "external_guest",
        externalActorReference: "a".repeat(64),
        agentId: "Atlas",
        botBindingId: "feishu-bot-atlas",
      },
    },
  })), {
    required: true,
    reasonCode: "feishu_external_guest_runtime_sensitive_tool_identity_required",
    externalActorReference: "a".repeat(64),
    agentId: "Atlas",
    botBindingId: "feishu-bot-atlas",
    externalChatId: "oc_runtime_guest",
    externalMessageId: "om_runtime_guest",
  });
});

test("honors external guest runtime-sensitive tool policy opt-out", () => {
  assert.deepEqual(evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(JSON.stringify({
    externalInput: {
      provider: "feishu",
      actor: {
        actorType: "external_guest",
        externalGuestRequireIdentityFor: ["writes", "approvals"],
      },
    },
  })), {
    required: false,
  });
});

test("does not apply external guest runtime tool requirements to bound users or other providers", () => {
  assert.deepEqual(evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(JSON.stringify({
    externalInput: {
      provider: "feishu",
      actor: {
        actorType: "user",
        userId: "user-1",
      },
    },
  })), {
    required: false,
  });

  assert.deepEqual(evaluateFeishuExternalGuestRuntimeToolIdentityRequirementFromTaskInput(JSON.stringify({
    externalInput: {
      provider: "slack",
      actor: {
        actorType: "external_guest",
      },
    },
  })), {
    required: false,
  });
});
