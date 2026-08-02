import type { TaskMessageRecord } from "@dofe-agent/db";

export interface ExecutionTimelineItem {
  id: string;
  kind: "status" | "thinking" | "tool" | "narration" | "error";
  title: string;
  subtitle?: string;
  detail?: string;
  status: "running" | "done" | "error";
  /** Provider-side call id linking a tool result to its call. */
  refId?: string;
}

const SUBTITLE_MAX_LENGTH = 80;
/** Input fields checked (in order) to build a short tool subtitle. */
const TOOL_SUBTITLE_FIELDS = ["command", "file_path", "path", "pattern", "query", "url"] as const;

function truncateSubtitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > SUBTITLE_MAX_LENGTH ? `${compact.slice(0, SUBTITLE_MAX_LENGTH - 1)}…` : compact;
}

function parseToolInput(inputJson: string | undefined): Record<string, unknown> | undefined {
  if (!inputJson) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(inputJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractToolSubtitle(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  for (const field of TOOL_SUBTITLE_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return truncateSubtitle(value);
    }
  }
  return undefined;
}

function formatToolInputDetail(inputJson: string | undefined): string | undefined {
  if (!inputJson) {
    return undefined;
  }
  const parsed = parseToolInput(inputJson);
  if (!parsed) {
    return inputJson;
  }
  if (typeof parsed.command === "string" && Object.keys(parsed).length === 1) {
    return parsed.command;
  }
  return JSON.stringify(parsed, null, 2);
}

function appendDetail(existing: string | undefined, addition: string | undefined): string | undefined {
  const trimmed = addition?.trim();
  if (!trimmed) {
    return existing;
  }
  return existing ? `${existing}\n\n${trimmed}` : trimmed;
}

/**
 * Reduce the raw task_message stream of one task into Kimi-style timeline items:
 * status rows, merged thinking blocks, and tool calls paired with their results.
 * When `options.taskRunning` is false, leftover running items are settled to done.
 */
export function buildExecutionTimeline(
  messages: TaskMessageRecord[],
  labels: { thinking: string },
  options?: { taskRunning?: boolean },
): ExecutionTimelineItem[] {
  const items: ExecutionTimelineItem[] = [];
  /** Indexes into `items` for tool calls still waiting for their result, in open order. */
  const openToolIndexes: number[] = [];

  const sorted = [...messages].sort((left, right) => left.seq - right.seq);
  for (const message of sorted) {
    if (message.type === "text") {
      // The final reply is rendered by the conversation bubble, not the timeline.
      continue;
    }

    if (message.type === "status") {
      const content = message.content?.trim();
      if (!content) {
        continue;
      }
      items.push({
        id: message.id,
        kind: "status",
        title: content,
        status: "done",
      });
      continue;
    }

    if (message.type === "narration") {
      const content = message.content?.trim();
      if (!content) {
        continue;
      }
      // User-facing agent narration ("内容输出"): rendered as a plain visible
      // text line, not folded into the collapsible thinking blocks.
      items.push({
        id: message.id,
        kind: "narration",
        title: content,
        status: "done",
      });
      continue;
    }

    if (message.type === "thinking") {
      const content = message.content?.trim();
      if (!content) {
        continue;
      }
      // One reported thinking event = one timeline item, so every reasoning
      // step stays individually visible instead of being merged into a blob.
      items.push({
        id: message.id,
        kind: "thinking",
        title: labels.thinking,
        detail: content,
        status: "running",
      });
      continue;
    }

    if (message.type === "tool_use") {
      const tool = message.tool?.trim() || "tool";
      const input = parseToolInput(message.inputJson);
      items.push({
        id: message.id,
        kind: "tool",
        title: tool,
        subtitle: extractToolSubtitle(input) ?? (message.content ? truncateSubtitle(message.content) : undefined),
        detail: formatToolInputDetail(message.inputJson) ?? message.content,
        status: "running",
        refId: message.refId,
      });
      openToolIndexes.push(items.length - 1);
      continue;
    }

    if (message.type === "tool_result") {
      const tool = message.tool?.trim() || "tool";
      // Pair exactly by provider call id when available, then by tool name,
      // then by the most recent open call as a last resort.
      let matchPosition = -1;
      if (message.refId) {
        for (let index = openToolIndexes.length - 1; index >= 0; index -= 1) {
          if (items[openToolIndexes[index]].refId === message.refId) {
            matchPosition = index;
            break;
          }
        }
      }
      if (matchPosition === -1) {
        for (let index = openToolIndexes.length - 1; index >= 0; index -= 1) {
          if (items[openToolIndexes[index]].title === tool) {
            matchPosition = index;
            break;
          }
        }
      }
      if (matchPosition === -1 && openToolIndexes.length > 0) {
        matchPosition = openToolIndexes.length - 1;
      }
      if (matchPosition === -1) {
        // The matching tool_use row may be missing (e.g. provider only reports
        // completions); still surface the result as a finished item.
        const output = message.output ?? message.content;
        items.push({
          id: message.id,
          kind: "tool",
          title: tool,
          detail: output,
          status: "done",
        });
        continue;
      }
      const itemIndex = openToolIndexes.splice(matchPosition, 1)[0];
      const item = items[itemIndex];
      item.status = "done";
      item.detail = appendDetail(item.detail, message.output ?? message.content);
      continue;
    }

    if (message.type === "error") {
      const content = message.content?.trim() || message.output?.trim();
      if (!content) {
        continue;
      }
      items.push({
        id: message.id,
        kind: "error",
        title: content,
        status: "error",
      });
    }
  }

  // A thinking block is "running" only while it is the latest timeline entry;
  // as soon as anything follows it, the thinking has finished.
  items.forEach((item, index) => {
    if (item.kind === "thinking") {
      item.status = index === items.length - 1 ? "running" : "done";
    }
  });

  if (options?.taskRunning === false) {
    for (const item of items) {
      if (item.status === "running") {
        item.status = "done";
      }
    }
  }

  return items;
}
