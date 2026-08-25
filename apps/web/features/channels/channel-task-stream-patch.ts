import type { ChannelDetailData } from "@/features/channels/channels-page-shared";
import type { ChannelsPageData } from "@/features/dashboard/data";

type ThreadMessage = ChannelsPageData["threads"][number]["messages"][number];
type TaskExecution = NonNullable<ChannelsPageData["threads"][number]["taskExecutions"]>[string][number];

export interface ChannelTaskStreamPatch {
  readonly channelName: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly messages: readonly ThreadMessage[];
  readonly taskExecutions: readonly TaskExecution[];
}

export function applyChannelTaskStreamPatches(
  current: Map<string, ChannelDetailData>,
  patches: readonly ChannelTaskStreamPatch[],
): Map<string, ChannelDetailData> {
  let next = current;

  for (const patch of patches) {
    const detail = next.get(patch.channelName);
    if (!detail) {
      continue;
    }
    const threadIndex = detail.threads.findIndex((thread) => thread.channelName === patch.channelName);
    if (threadIndex < 0) {
      continue;
    }

    const thread = detail.threads[threadIndex];
    const normalizedMessages = patch.messages.map((message) => ({
      ...message,
      conversationId: message.conversationId ?? patch.conversationId,
    }));
    const incomingMessages = new Map(normalizedMessages.map((message) => [message.id, message]));
    const messages = thread.messages.map((message) => {
      const incoming = incomingMessages.get(message.id);
      if (!incoming) {
        return message;
      }
      incomingMessages.delete(message.id);
      return { ...message, ...incoming };
    });
    messages.push(...incomingMessages.values());

    const rowsBySeq = new Map(
      (thread.taskExecutions?.[patch.taskId] ?? []).map((item) => [item.seq, item]),
    );
    for (const item of patch.taskExecutions) {
      rowsBySeq.set(item.seq, item);
    }

    const threads = detail.threads.slice();
    threads[threadIndex] = {
      ...thread,
      messages,
      taskExecutions: {
        ...thread.taskExecutions,
        [patch.taskId]: [...rowsBySeq.values()].sort((left, right) => left.seq - right.seq),
      },
    };
    if (next === current) {
      next = new Map(current);
    }
    next.set(patch.channelName, { ...detail, threads });
  }

  return next;
}
