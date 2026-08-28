import assert from "node:assert/strict";
import test from "node:test";
import { enqueueTaskCompletionFeishuOutbox } from "./task-completion-outbox.ts";

const input = {
  workspaceId: "workspace-1",
  channelName: "general",
  agentId: "agent-1",
  text: "done",
  dofeAgentMessageId: "message-1",
  statusCard: {
    status: "complete" as const,
    agentNames: ["agent-1"],
    taskId: "task-1",
  },
};

test("completion outbox reports all queued messages", () => {
  const result = enqueueTaskCompletionFeishuOutbox(input, {
    queueStatusCard: () => [{ id: "status" }],
    queueReply: () => [{ id: "reply" }],
  });
  assert.deepEqual(result, ["Feishu outbound queued: 2 message(s)."]);
});

test("completion outbox propagates enqueue failures for journal recovery", () => {
  assert.throws(() => enqueueTaskCompletionFeishuOutbox(input, {
    queueStatusCard: () => [{ id: "status" }],
    queueReply: () => {
      throw new Error("outbox unavailable");
    },
  }), /outbox unavailable/);
});
