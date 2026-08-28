import { describe, expect, it } from "vitest";
import type { ChannelDetailData } from "@/features/channels/channels-page-shared";
import type { ChannelsPageData } from "@/features/dashboard/data";
import { applyChannelTaskStreamPatches } from "@/features/channels/channel-task-stream-patch";

type ThreadMessage = ChannelsPageData["threads"][number]["messages"][number];
type TaskExecution = NonNullable<ChannelsPageData["threads"][number]["taskExecutions"]>[string][number];

const seedReply: ThreadMessage = {
  id: "reply-1",
  speaker: "Planner",
  role: "agent",
  time: "10:00",
  summary: "处理中",
};

function row(seq: number, content: string): TaskExecution {
  return {
    id: `row-${seq}`,
    taskId: "task-1",
    seq,
    type: "text",
    content,
    createdAt: `2026-08-25T10:00:0${seq}.000Z`,
  };
}

function seedDetailMap(): Map<string, ChannelDetailData> {
  return new Map([
    ["tour visit", {
      channelFiles: [],
      detailScope: ["tour visit"],
      documentConflicts: [],
      documentRuns: [],
      documents: [],
      threads: [{
        channelName: "tour visit",
        messages: [seedReply],
        taskExecutions: { "task-1": [row(1, "第一段")] },
      }],
    }],
  ]);
}

describe("applyChannelTaskStreamPatches", () => {
  it("deduplicates task rows by seq and keeps them ordered", () => {
    const next = applyChannelTaskStreamPatches(seedDetailMap(), [{
      channelName: "tour visit",
      conversationId: "conversation-1",
      taskId: "task-1",
      messages: [{ ...seedReply, summary: "最终回复" }],
      taskExecutions: [row(3, "第三段"), row(2, "第二段"), row(2, "第二段")],
    }]);

    expect(next.get("tour visit")?.threads[0].taskExecutions?.["task-1"].map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(next.get("tour visit")?.threads[0].messages.find((item) => item.id === seedReply.id)?.summary).toBe("最终回复");
  });

  it("normalizes message conversation ids and merges two tasks in one batch", () => {
    const current = seedDetailMap();
    const next = applyChannelTaskStreamPatches(current, [
      {
        channelName: "tour visit",
        conversationId: "conversation-1",
        taskId: "task-1",
        messages: [{ ...seedReply, summary: "第一任务完成" }],
        taskExecutions: [row(2, "第二段")],
      },
      {
        channelName: "tour visit",
        conversationId: "conversation-1",
        taskId: "task-2",
        messages: [{ ...seedReply, id: "reply-2", summary: "第二任务完成" }],
        taskExecutions: [{ ...row(1, "另一任务"), id: "task-2-row-1", taskId: "task-2" }],
      },
    ]);

    expect(next).not.toBe(current);
    expect(next.get("tour visit")?.threads[0].messages.at(-1)?.conversationId).toBe("conversation-1");
    expect(next.get("tour visit")?.threads[0].taskExecutions?.["task-2"]).toHaveLength(1);
  });

  it("preserves unscoped messages when a live channel task has no conversation id", () => {
    const next = applyChannelTaskStreamPatches(seedDetailMap(), [{
      channelName: "tour visit",
      taskId: "task-1",
      messages: [{ ...seedReply, summary: "流式回复" }],
      taskExecutions: [row(2, "第二段")],
    }]);

    expect(next.get("tour visit")?.threads[0].messages[0]).not.toHaveProperty("conversationId");
    expect(next.get("tour visit")?.threads[0].taskExecutions?.["task-1"]).toHaveLength(2);
  });

  it("preserves the current map for empty patches and unknown channels", () => {
    const current = seedDetailMap();

    expect(applyChannelTaskStreamPatches(current, [])).toBe(current);
    expect(applyChannelTaskStreamPatches(current, [{
      channelName: "unknown",
      conversationId: "conversation-1",
      taskId: "task-1",
      messages: [],
      taskExecutions: [],
    }])).toBe(current);
  });

  it("seeds a missing channel detail during a cache reload", () => {
    const seed = seedDetailMap().get("tour visit")!;
    const next = applyChannelTaskStreamPatches(new Map(), [{
      channelName: "tour visit",
      taskId: "task-1",
      seedDetail: seed,
      messages: [],
      taskExecutions: [row(2, "第二段")],
    }]);

    expect(next.get("tour visit")?.threads[0].taskExecutions?.["task-1"].map((item) => item.seq)).toEqual([1, 2]);
  });
});
