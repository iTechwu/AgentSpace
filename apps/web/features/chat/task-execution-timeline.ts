import type { TaskMessageRecord } from "@dofe-agent/db";

export interface ExecutionTimelineItem {
  id: string;
  kind: "status" | "thinking" | "tool" | "narration" | "error";
  title: string;
  subtitle?: string;
  detail?: string;
  /** Tool input retained separately so the disclosure can render an IN section. */
  inputDetail?: string;
  /** Tool output retained separately so the disclosure can render an OUT section. */
  outputDetail?: string;
  status: "running" | "done" | "error";
  /** Provider-side call id linking a tool result to its call. */
  refId?: string;
}

export interface TaskExecutionStreamProjection {
  items: ExecutionTimelineItem[];
  /** Complete assistant text reconstructed from ordered runtime text chunks. */
  assistantText: string;
  /** Highest task-local sequence included in this projection. */
  lastSeq: number;
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

function formatRuntimePayload(message: TaskMessageRecord): string | undefined {
  const sections: string[] = [];
  const content = message.content?.trim();
  const input = message.inputJson?.trim();
  const output = message.output?.trim();
  if (content) {
    sections.push(content);
  }
  if (input && input !== "{}") {
    const parsed = parseToolInput(input);
    sections.push(`input:\n${parsed ? JSON.stringify(parsed, null, 2) : input}`);
  }
  if (output && output !== content) {
    sections.push(`output:\n${output}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function appendDetail(existing: string | undefined, addition: string | undefined): string | undefined {
  const trimmed = addition?.trim();
  if (!trimmed) {
    return existing;
  }
  return existing ? `${existing}\n\n${trimmed}` : trimmed;
}

function containsProviderDiagnostic(value: string | undefined): boolean {
  return Boolean(value && /(?:provider\.runtime_generic_failure|Codex CLI exited|Claude CLI exited|stderrTail=|exitCode=|provider diagnostic:|No such image:)/i.test(value));
}

function settleStatusTitle(value: string, taskRunning: boolean | undefined): string {
  if (taskRunning !== false) {
    return value;
  }
  if (value === "正在准备执行环境") {
    return "执行环境已准备";
  }
  if (/^Preparing (?:the )?execution environment$/i.test(value)) {
    return "Execution environment ready";
  }
  return value;
}

/**
 * Reduce the raw task_message stream of one task into Kimi-style timeline items:
 * status rows, merged thinking blocks, and tool calls paired with their results.
 * When `options.taskRunning` is false, leftover running items are settled to done.
 * `options.includeText` is intended for audit/inbox surfaces where the raw
 * stream must remain self-contained; chat already renders text as bubbles.
 */
export function buildExecutionTimeline(
  messages: TaskMessageRecord[],
  labels: { thinking: string; usage?: string; runtimeEvent?: string; error?: (value: string) => string },
  options?: { taskRunning?: boolean; includeText?: boolean },
): ExecutionTimelineItem[] {
  return buildTaskExecutionStream(messages, labels, options).items;
}

/**
 * Projects the durable runtime stream into stable timeline nodes plus the
 * complete assistant text reconstructed from ordered text chunks.
 */
export function buildTaskExecutionStream(
  messages: TaskMessageRecord[],
  labels: { thinking: string; usage?: string; runtimeEvent?: string; error?: (value: string) => string },
  options?: { taskRunning?: boolean; includeText?: boolean },
): TaskExecutionStreamProjection {
  const items: ExecutionTimelineItem[] = [];
  const assistantTextParts: string[] = [];
  /** Indexes into `items` for tool calls still waiting for their result, in open order. */
  const openToolIndexes: number[] = [];
  let openThinkingIndex: number | null = null;

  const sorted = [...messages].sort((left, right) => left.seq - right.seq);
  for (const message of sorted) {
    if (message.type !== "thinking") {
      openThinkingIndex = null;
    }
    if (message.type === "text") {
      if (message.content) {
        assistantTextParts.push(message.content);
      }
      const content = message.content?.trim();
      if (options?.includeText && content) {
        items.push({
          id: message.id,
          kind: "narration",
          title: content,
          status: "done",
        });
      }
      // Chat renders the final reply as a conversation bubble. Audit/inbox
      // surfaces opt in above so their raw stream stays complete on its own.
      continue;
    }

    if (message.type === "status") {
      const content = message.content?.trim();
      if (!content || /^provider diagnostic:/i.test(content)) {
        continue;
      }
      items.push({
        id: message.id,
        kind: "status",
        title: settleStatusTitle(content, options?.taskRunning),
        status: "done",
      });
      continue;
    }

    if (message.type === "usage") {
      items.push({
        id: message.id,
        kind: "status",
        title: labels.usage ?? "Runtime usage",
        subtitle: message.content ? truncateSubtitle(message.content) : undefined,
        detail: formatRuntimePayload(message),
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
      if (openThinkingIndex !== null) {
        const runningThinking = items[openThinkingIndex];
        runningThinking.detail = appendDetailWithSeparator(runningThinking.detail, content, "\n");
        continue;
      }
      items.push({
        id: message.id,
        kind: "thinking",
        title: labels.thinking,
        detail: content,
        status: "running",
      });
      openThinkingIndex = items.length - 1;
      continue;
    }

    if (message.type === "tool_use") {
      const tool = message.tool?.trim() || "tool";
      const input = parseToolInput(message.inputJson);
      const inputDetail = formatToolInputDetail(message.inputJson) ?? message.content;
      items.push({
        id: message.id,
        kind: "tool",
        title: tool,
        subtitle: extractToolSubtitle(input) ?? (message.content ? truncateSubtitle(message.content) : undefined),
        detail: inputDetail,
        inputDetail,
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
          outputDetail: output,
          status: "done",
        });
        continue;
      }
      const itemIndex = openToolIndexes.splice(matchPosition, 1)[0];
      const item = items[itemIndex];
      const output = message.output ?? message.content;
      item.status = "done";
      item.outputDetail = appendDetail(item.outputDetail, output);
      item.detail = appendDetail(item.detail, output);
      continue;
    }

    if (message.type === "error") {
      const content = message.content?.trim() || message.output?.trim();
      if (!content) {
        continue;
      }
      const rawDetail = message.output && message.output.trim() !== content
        ? formatRuntimePayload(message)
        : undefined;
      items.push({
        id: message.id,
        kind: "error",
        title: labels.error?.(content) ?? content,
        detail: containsProviderDiagnostic(content) || containsProviderDiagnostic(rawDetail) ? undefined : rawDetail,
        status: "error",
      });
      continue;
    }

    // Preserve forward-compatible provider events instead of silently dropping
    // them when a runtime adds a new stream item type.
    const unknownDetail = formatRuntimePayload(message);
    items.push({
      id: message.id,
      kind: "status",
      title: message.type.trim() || labels.runtimeEvent || "Runtime event",
      detail: unknownDetail,
      status: "done",
    });
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

  return {
    items,
    assistantText: assistantTextParts.join(""),
    lastSeq: sorted.at(-1)?.seq ?? 0,
  };
}

function appendDetailWithSeparator(
  existing: string | undefined,
  addition: string | undefined,
  separator: string,
): string | undefined {
  const trimmed = addition?.trim();
  if (!trimmed) {
    return existing;
  }
  return existing ? `${existing}${separator}${trimmed}` : trimmed;
}
