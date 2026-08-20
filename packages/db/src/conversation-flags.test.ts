import assert from "node:assert/strict";
import test from "node:test";
import { readConversationFeatureFlags } from "./conversation-flags.ts";

test("readConversationFeatureFlags 默认反映已完成 rollout", () => {
  const flags = readConversationFeatureFlags({});
  assert.equal(flags.conversationV2Enabled, true);
  assert.equal(flags.conversationV2DualWrite, false);
  assert.equal(flags.taskQueueByConversation, "on");
  assert.equal(flags.conversationHistoryServer, true);
  assert.equal(flags.runtimeTaskCapacityEnabled, false);
});

test("readConversationFeatureFlags 解析环境变量覆盖", () => {
  const flags = readConversationFeatureFlags({
    CONVERSATION_V2_ENABLED: "0",
    TASK_QUEUE_BY_CONVERSATION: "off",
    CONVERSATION_HISTORY_SERVER: "0",
    RUNTIME_TASK_CAPACITY_ENABLED: "1",
    CONVERSATION_V2_DUAL_WRITE: "1",
  });
  assert.equal(flags.conversationV2Enabled, false);
  assert.equal(flags.taskQueueByConversation, "off");
  assert.equal(flags.conversationHistoryServer, false);
  assert.equal(flags.runtimeTaskCapacityEnabled, true);
  assert.equal(flags.conversationV2DualWrite, true);
});
