import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeFeishuApprovalCardActionEventPayload,
  summarizeFeishuInboundEventPayload,
} from "../event-summary.ts";

test("summarizeFeishuInboundEventPayload redacts raw message content", () => {
  const summary = summarizeFeishuInboundEventPayload({
    schema: "2.0",
    header: {
      event_id: "evt-redacted",
      event_type: "im.message.receive_v1",
      create_time: "1782288000000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender",
          union_id: "on_sender",
        },
      },
      message: {
        message_id: "om_secret",
        chat_id: "oc_general",
        message_type: "text",
        content: JSON.stringify({
          text: "@Atlas summarize the confidential launch plan",
        }),
      },
    },
  });

  assert.equal(summary.rawPayloadStored, false);
  assert.equal(summary.contentRedacted, true);
  const messageSummary = summary.message as Record<string, unknown>;
  const senderSummary = summary.sender as Record<string, unknown>;
  assert.match(String(summary.externalEventReference), /^event [a-f0-9]{16}$/);
  assert.equal(summary.externalEventIdRedacted, true);
  assert.match(String(messageSummary.messageReference), /^message [a-f0-9]{16}$/);
  assert.equal(messageSummary.messageIdRedacted, true);
  assert.match(String(messageSummary.chatReference), /^chat [a-f0-9]{16}$/);
  assert.equal(messageSummary.chatIdRedacted, true);
  assert.equal(messageSummary.messageType, "text");
  assert.match(String(messageSummary.contentHash), /^[a-f0-9]{64}$/);
  assert.match(String(senderSummary.openIdReference), /^user [a-f0-9]{16}$/);
  assert.equal(senderSummary.openIdRedacted, true);
  assert.match(String(senderSummary.unionIdReference), /^union [a-f0-9]{16}$/);
  assert.equal(senderSummary.unionIdRedacted, true);
  assert.match(String(summary.payloadHash), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(summary), /confidential launch plan/);
  assert.doesNotMatch(JSON.stringify(summary), /evt-redacted|om_secret|oc_general|ou_sender|on_sender/);
});

test("summarizeFeishuApprovalCardActionEventPayload records safe governance context", () => {
  const summary = summarizeFeishuApprovalCardActionEventPayload({
    schema: "2.0",
    header: {
      event_id: "evt-card-action",
      event_type: "card.action.trigger",
      create_time: "1782288000000",
    },
    event: {
      action: {
        value: {
          approvalId: "approval-1",
          decision: "approved",
          payloadHash: "sha256:approval-payload",
          token: "secret-card-token",
        },
      },
    },
  }, {
    approvalId: "approval-1",
    decision: "approved",
    payloadHash: "sha256:approval-payload",
  });

  const approvalCardAction = summary.approvalCardAction as Record<string, unknown>;
  assert.equal(summary.rawPayloadStored, false);
  assert.equal(approvalCardAction.provider, "feishu");
  assert.equal(approvalCardAction.kind, "data_operation_approval");
  assert.equal(approvalCardAction.approvalId, "approval-1");
  assert.equal(approvalCardAction.payloadHash, "sha256:approval-payload");
  assert.equal(approvalCardAction.decision, "approved");
  assert.equal(approvalCardAction.tokenStored, false);
  assert.equal(approvalCardAction.rawActionPayloadStored, false);
  assert.doesNotMatch(JSON.stringify(summary), /secret-card-token/);
});
