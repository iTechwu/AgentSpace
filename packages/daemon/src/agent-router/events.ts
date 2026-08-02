import type { AgentRouterEvent } from "./types.ts";
import { extractSessionId, extractText, extractUsage, extractGatewayRequestId, readNumberAtPaths, readStringAtPaths, readValueAtPaths } from "./utils.ts";

export interface ClaudeEventMapperState {
  /** tool_use block id → tool name, so tool_result blocks can be attributed. */
  toolNameByUseId: Map<string, string>;
}

export function createClaudeEventMapperState(): ClaudeEventMapperState {
  return { toolNameByUseId: new Map() };
}

/**
 * Stateful wrapper around observer.emit for narration events. The latest
 * narration is held back by one event so that a final answer duplicating it
 * (Codex emits the last agent_message twice, Claude repeats it in the result
 * event) can drop the held copy instead of showing the answer twice.
 */
export function createNarrationDedupEmitter(emit: (event: AgentRouterEvent) => void): {
  emit: (event: AgentRouterEvent) => void;
  flush: (finalText?: string) => void;
} {
  let held: string | undefined;
  const flush = (finalText?: string): void => {
    if (held === undefined) {
      return;
    }
    const text = held;
    held = undefined;
    if (finalText !== undefined && finalText.trim() === text.trim()) {
      return;
    }
    emit({ type: "narration_delta", text });
  };
  return {
    emit(event: AgentRouterEvent): void {
      if (event.type === "narration_delta") {
        flush();
        held = event.text;
        return;
      }
      flush(event.type === "text_delta" ? event.text : undefined);
      emit(event);
    },
    flush,
  };
}

export function mapClaudeNativeEvent(event: Record<string, unknown>, state?: ClaudeEventMapperState): AgentRouterEvent[] {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "result") {
    const result: AgentRouterEvent[] = [];
    if (typeof event.usage === "object" && event.usage) {
      const usage = event.usage as Record<string, unknown>;
      result.push({
        type: "tool_output",
        tool: "usage",
        metadata: {
          input_tokens: usage.input_tokens ?? usage.inputTokens,
          output_tokens: usage.output_tokens ?? usage.outputTokens,
          gateway_request_id: extractGatewayRequestId(event),
        },
      });
    }
    result.push(...extractClaudePermissionDenials(event).map((denial) => ({
      type: "approval_requested" as const,
      toolName: denial.toolName,
      toolInput: denial.toolInput,
      contentPreview: formatToolApprovalPreview(denial.toolName, denial.toolInput),
    })));
    return result;
  }

  if (type === "assistant" || type === "user") {
    return mapClaudeMessageContentBlocks(type, event, state);
  }

  if (type === "text" || type === "message") {
    const text = extractText(event.text ?? event.content);
    return text ? [{ type: "text_delta", text }] : [];
  }

  if (type === "content_block_delta" && event.delta && typeof event.delta === "object") {
    const text = extractText((event.delta as Record<string, unknown>).text);
    return text ? [{ type: "text_delta", text }] : [];
  }

  if (type === "tool_use") {
    return [{
      type: "tool_started",
      tool: typeof event.name === "string" ? event.name : "unknown",
      title: typeof event.name === "string" ? event.name : undefined,
      input: typeof event.input === "object" && event.input ? event.input : undefined,
    }];
  }

  if (type === "tool_result") {
    const tool = typeof event.name === "string" ? event.name : "unknown";
    const output = extractText(event.output ?? event.content);
    return [
      { type: "tool_output", tool, output },
      { type: "tool_finished", tool, status: "completed" },
    ];
  }

  return [];
}

/**
 * Expand one Claude stream-json assistant/user message into per-block events:
 * every text/thinking/tool_use/tool_result block becomes its own router event,
 * so each step of the run is individually visible downstream.
 */
function mapClaudeMessageContentBlocks(
  type: "assistant" | "user",
  event: Record<string, unknown>,
  state?: ClaudeEventMapperState,
): AgentRouterEvent[] {
  const message = event.message && typeof event.message === "object"
    ? event.message as Record<string, unknown>
    : undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    if (type === "assistant") {
      const text = extractClaudeAssistantText(event);
      return text ? [{ type: "narration_delta", text }] : [];
    }
    return [];
  }

  const mapped: AgentRouterEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as Record<string, unknown>;
    const blockType = typeof typedBlock.type === "string" ? typedBlock.type : "";

    if (blockType === "text" && type === "assistant") {
      // Assistant text between tool calls is user-facing narration ("内容输出"),
      // not chain-of-thought; thinking blocks below carry the actual reasoning.
      const text = extractText(typedBlock.text);
      if (text) {
        mapped.push({ type: "narration_delta", text });
      }
      continue;
    }

    if (blockType === "thinking") {
      const text = extractText(typedBlock.thinking ?? typedBlock.text);
      if (text) {
        mapped.push({ type: "thought_delta", text });
      }
      continue;
    }

    if (blockType === "tool_use") {
      const tool = typeof typedBlock.name === "string" ? typedBlock.name : "unknown";
      const useId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
      if (useId && state) {
        state.toolNameByUseId.set(useId, tool);
      }
      mapped.push({
        type: "tool_started",
        tool,
        title: tool,
        input: typeof typedBlock.input === "object" && typedBlock.input ? typedBlock.input : undefined,
        toolUseId: useId,
      });
      continue;
    }

    if (blockType === "tool_result") {
      const useId = typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : undefined;
      const tool = (useId && state?.toolNameByUseId.get(useId)) || "tool";
      const output = extractText(typedBlock.content ?? typedBlock.output);
      mapped.push(
        { type: "tool_output", tool, output, toolUseId: useId },
        { type: "tool_finished", tool, status: typedBlock.is_error === true ? "failed" : "completed", toolUseId: useId },
      );
    }
  }
  return mapped;
}

export interface CodexEventMapperState {
  /** Item ids for which a tool_started was already emitted, so completions of
   * items whose start event was never seen can synthesize one. */
  seenToolStarts: Set<string>;
}

export function createCodexEventMapperState(): CodexEventMapperState {
  return { seenToolStarts: new Set() };
}

export function mapCodexNativeEvent(event: Record<string, unknown>, state?: CodexEventMapperState): AgentRouterEvent[] {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "item.started" || type === "item.completed") {
    const item = event.item;
    if (!item || typeof item !== "object") {
      return [];
    }
    const typedItem = item as Record<string, unknown>;
    const itemType = normalizeCodexItemType(typedItem.type);
    const itemId = typeof typedItem.id === "string" ? typedItem.id : undefined;
    const markStarted = (): void => {
      if (itemId) {
        state?.seenToolStarts.add(itemId);
      }
    };
    // When the provider only reports a completion (no matching item.started),
    // synthesize the start event so the step still shows its input downstream.
    const synthesizedStart = (started: AgentRouterEvent | undefined): AgentRouterEvent[] => {
      if (type === "item.started") {
        markStarted();
        return started ? [started] : [];
      }
      const prefix = started && itemId && state && !state.seenToolStarts.has(itemId) ? [started] : [];
      return prefix;
    };

    if (itemType === "command_execution") {
      const command = typeof typedItem.command === "string"
        ? typedItem.command
        : readStringAtPaths(typedItem, [["input", "command"]]);
      const startEvent: AgentRouterEvent = {
        type: "tool_started",
        tool: "exec_command",
        title: command ? `bash: ${command}` : "bash",
        input: command ? { command } : undefined,
        toolUseId: itemId,
      };
      if (type === "item.started") {
        markStarted();
        return [startEvent];
      }

      const output = typeof typedItem.aggregatedOutput === "string"
        ? typedItem.aggregatedOutput
        : typeof typedItem.aggregated_output === "string"
          ? typedItem.aggregated_output
        : typeof typedItem.output === "string"
          ? typedItem.output
          : undefined;
      return [
        ...synthesizedStart(startEvent),
        { type: "tool_output", tool: "exec_command", output, toolUseId: itemId },
        { type: "tool_finished", tool: "exec_command", status: "completed", toolUseId: itemId },
      ];
    }

    if (itemType === "file_change") {
      const startEvent: AgentRouterEvent = { type: "tool_started", tool: "patch_apply", title: "file change", toolUseId: itemId };
      return type === "item.started"
        ? (markStarted(), [startEvent])
        : [
            ...synthesizedStart(startEvent),
            { type: "tool_finished", tool: "patch_apply", status: "completed", toolUseId: itemId },
          ];
    }

    if (itemType === "web_search") {
      const query = typeof typedItem.query === "string"
        ? typedItem.query
        : readStringAtPaths(typedItem, [["action", "query"]]);
      const startEvent: AgentRouterEvent = {
        type: "tool_started",
        tool: "web_search",
        title: query ? `web search: ${query}` : "web search",
        input: query ? { query } : undefined,
        toolUseId: itemId,
      };
      if (type === "item.started") {
        markStarted();
        return [startEvent];
      }
      return [
        ...synthesizedStart(startEvent),
        { type: "tool_output", tool: "web_search", output: query, toolUseId: itemId },
        { type: "tool_finished", tool: "web_search", status: "completed", toolUseId: itemId },
      ];
    }

    if (itemType === "mcp_tool_call") {
      const serverLabel = readStringAtPaths(typedItem, [["server_label"], ["serverLabel"], ["server"]]);
      const toolName = readStringAtPaths(typedItem, [["tool"], ["name"]]);
      const tool = [serverLabel, toolName].filter(Boolean).join(".") || "mcp_tool";
      const args = typedItem.arguments;
      const startEvent: AgentRouterEvent = {
        type: "tool_started",
        tool,
        title: tool,
        input: args && typeof args === "object" ? args : typeof args === "string" ? { arguments: args } : undefined,
        toolUseId: itemId,
      };
      if (type === "item.started") {
        markStarted();
        return [startEvent];
      }
      const errorText = readStringAtPaths(typedItem, [["error", "message"], ["error"]]);
      const result = typedItem.result;
      const output = errorText
        ?? (typeof result === "string" ? result : result ? JSON.stringify(result) : undefined);
      return [
        ...synthesizedStart(startEvent),
        { type: "tool_output", tool, output, toolUseId: itemId },
        { type: "tool_finished", tool, status: errorText ? "failed" : "completed", toolUseId: itemId },
      ];
    }

    if (itemType === "reasoning") {
      if (type !== "item.completed") {
        return [];
      }
      const text = Array.isArray(typedItem.text)
        ? typedItem.text.filter((part): part is string => typeof part === "string").join("\n")
        : typeof typedItem.text === "string"
          ? typedItem.text
          : undefined;
      return text ? [{ type: "thought_delta", text }] : [];
    }

    if (itemType === "agent_message" && typeof typedItem.text === "string") {
      return typedItem.phase === "final_answer"
        ? [{ type: "text_delta", text: typedItem.text }]
        : [{ type: "narration_delta", text: typedItem.text }];
    }

    // Catch-all: never silently drop a completed item that carries user-readable
    // text — surface it as narration so the timeline stays complete even when
    // the provider introduces item types this mapper does not know yet.
    if (type === "item.completed" && typeof typedItem.text === "string" && typedItem.text.trim()) {
      return [{ type: "narration_delta", text: typedItem.text }];
    }
  }

  if (type === "thread.started") {
    const sessionId = readStringAtPaths(event, [["thread_id"], ["threadId"]]);
    return sessionId ? [{ type: "session_updated", sessionId }] : [];
  }

  return [];
}

export function mapOpenClawNativeEvent(event: Record<string, unknown>): AgentRouterEvent[] {
  const sessionId = readStringAtPaths(event, [
    ["sessionId"],
    ["session_id"],
    ["conversationId"],
    ["conversation_id"],
    ["result", "sessionId"],
    ["result", "session_id"],
    ["result", "conversationId"],
    ["result", "conversation_id"],
    ["meta", "sessionId"],
    ["meta", "session_id"],
  ]);
  const result: AgentRouterEvent[] = sessionId ? [{ type: "session_updated", sessionId }] : [];
  const type = typeof event.type === "string" ? event.type : "";
  const eventName = typeof event.event === "string" ? event.event : "";

  const status = readStringAtPaths(event, [
    ["status"],
    ["phase"],
    ["state"],
    ["result", "status"],
    ["message", "status"],
  ]);
  if ((type === "status" || eventName === "status" || status) && !isTerminalTextOpenClawEvent(event)) {
    const statusText = extractText(event.message ?? event.content ?? event.text ?? status);
    if (statusText) {
      result.push({ type: "thought_delta", text: statusText });
    }
  }

  const toolName = readStringAtPaths(event, [
    ["tool"],
    ["toolName"],
    ["tool_name"],
    ["name"],
    ["tool", "name"],
    ["message", "tool"],
    ["result", "tool"],
  ]);
  if (toolName && /tool|command|exec|function/i.test(`${type} ${eventName}`)) {
    if (/start|started|call|calling|tool_use/i.test(`${type} ${eventName}`)) {
      result.push({
        type: "tool_started",
        tool: toolName,
        title: toolName,
        input: readOpenClawToolInput(event),
      });
    } else if (/finish|finished|result|output|complete|completed|failed|error/i.test(`${type} ${eventName}`)) {
      const output = extractText(event.output ?? event.result ?? event.content ?? event.message);
      result.push({ type: "tool_output", tool: toolName, output });
      result.push({
        type: "tool_finished",
        tool: toolName,
        status: /fail|error|denied/i.test(`${type} ${eventName} ${status ?? ""}`) ? "failed" : "completed",
      });
    }
  }

  const text = extractTextFromOpenClawEvent(event);
  if (text) {
    result.push({ type: "text_delta", text });
  }

  const usage = extractUsage(event);
  if (usage) {
    result.push({
      type: "tool_output",
      tool: "usage",
      metadata: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        gateway_request_id: extractGatewayRequestId(event),
      },
    });
  }

  return result;
}

export function mapOpenCodeNativeEvent(event: Record<string, unknown>): AgentRouterEvent[] {
  const result: AgentRouterEvent[] = [];
  const sessionId = extractSessionId(event);
  if (sessionId) {
    result.push({ type: "session_updated", sessionId });
  }

  const type = typeof event.type === "string" ? event.type : "";
  const eventName = typeof event.event === "string" ? event.event : "";
  const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
  const combinedType = `${type} ${eventName} ${typeof part?.type === "string" ? part.type : ""}`;

  const toolName = readOpenCodeToolName(event);
  if (toolName && /tool|command|exec|function/i.test(combinedType)) {
    if (/start|started|call|calling|tool_use/i.test(combinedType)) {
      result.push({
        type: "tool_started",
        tool: toolName,
        title: toolName,
        input: readOpenCodeToolInput(event),
      });
    } else if (/finish|finished|result|output|complete|completed|failed|error/i.test(combinedType)) {
      const output = extractText(event.output ?? event.result ?? part?.output ?? part?.result ?? event.content ?? event.message);
      result.push({ type: "tool_output", tool: toolName, output });
      result.push({
        type: "tool_finished",
        tool: toolName,
        status: /fail|error|denied/i.test(combinedType) ? "failed" : "completed",
      });
    }
  }

  const usage = extractOpenCodeUsage(event);
  if (usage) {
    result.push({
      type: "tool_output",
      tool: "usage",
      metadata: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        gateway_request_id: extractGatewayRequestId(event),
      },
    });
  }

  if (type === "text" || type === "message") {
    const text = extractOpenCodeFinalText(event);
    if (text) {
      result.push({ type: "text_delta", text });
    }
    return result;
  }

  if (type === "step_start" || type === "step" || type === "status") {
    const text = extractOpenCodeStepText(event);
    if (text) {
      result.push({ type: "thought_delta", text });
    }
    return result;
  }

  const finalText = extractOpenCodeFinalText(event);
  if (finalText && !/step_finish|usage|debug/i.test(combinedType)) {
    result.push({ type: "text_delta", text: finalText });
  }

  return result;
}

export function extractClaudeFallbackText(event: Record<string, unknown>): string | undefined {
  if (event.type === "result" && typeof event.result === "string") {
    return event.result.trim() || undefined;
  }
  if (event.type === "assistant") {
    return extractClaudeAssistantText(event);
  }
  if (event.type === "text" || event.type === "message") {
    return extractText(event.text ?? event.content);
  }
  if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
    return extractText((event.delta as Record<string, unknown>).text);
  }
  return undefined;
}

export function extractCodexFinalText(event: Record<string, unknown>): string | undefined {
  const item = event.item;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const typedItem = item as Record<string, unknown>;
  if (normalizeCodexItemType(typedItem.type) === "agent_message" && typeof typedItem.text === "string") {
    if (typedItem.phase && typedItem.phase !== "final_answer") {
      return undefined;
    }
    return typedItem.text.trim() || undefined;
  }
  return undefined;
}

export function extractOpenCodeFinalText(event: Record<string, unknown>): string | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "step_start" || type === "step" || type === "status" || type === "step_finish" || type === "usage" || type === "debug") {
    return undefined;
  }

  return extractText(
    readValueAtPaths(event, [
      ["part", "text"],
      ["part", "content"],
      ["part", "message"],
      ["text"],
      ["content"],
      ["message"],
      ["result", "text"],
      ["result", "content"],
    ]),
  );
}

function normalizeCodexItemType(value: unknown): string {
  if (value === "commandExecution" || value === "command_execution") {
    return "command_execution";
  }
  if (value === "fileChange" || value === "file_change") {
    return "file_change";
  }
  if (value === "agentMessage" || value === "agent_message") {
    return "agent_message";
  }
  if (value === "webSearch" || value === "web_search") {
    return "web_search";
  }
  if (value === "mcpToolCall" || value === "mcp_tool_call") {
    return "mcp_tool_call";
  }
  return typeof value === "string" ? value : "";
}

function extractClaudeAssistantText(event: Record<string, unknown>): string | undefined {
  const message = event.message && typeof event.message === "object"
    ? event.message as Record<string, unknown>
    : undefined;
  return extractText(message?.content ?? event.content);
}

function extractTextFromOpenClawEvent(event: Record<string, unknown>): string | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "usage" || type === "debug" || type === "status") {
    return undefined;
  }
  return extractText(event);
}

function extractOpenCodeStepText(event: Record<string, unknown>): string | undefined {
  return extractText(
    readValueAtPaths(event, [
      ["part", "title"],
      ["part", "text"],
      ["message"],
      ["content"],
      ["text"],
    ]),
  );
}

function extractOpenCodeUsage(event: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const sharedUsage = extractUsage(event);
  if (sharedUsage) {
    return sharedUsage;
  }

  const inputTokens = readNumberAtPaths(event, [
    ["tokens", "input"],
    ["tokens", "inputTokens"],
    ["tokens", "input_tokens"],
    ["part", "tokens", "input"],
    ["part", "tokens", "inputTokens"],
    ["part", "tokens", "input_tokens"],
  ]) ?? 0;
  const outputTokens = readNumberAtPaths(event, [
    ["tokens", "output"],
    ["tokens", "outputTokens"],
    ["tokens", "output_tokens"],
    ["part", "tokens", "output"],
    ["part", "tokens", "outputTokens"],
    ["part", "tokens", "output_tokens"],
  ]) ?? 0;

  if (inputTokens <= 0 && outputTokens <= 0) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function readOpenCodeToolName(event: Record<string, unknown>): string | undefined {
  return readStringAtPaths(event, [
    ["tool"],
    ["toolName"],
    ["tool_name"],
    ["name"],
    ["part", "tool"],
    ["part", "toolName"],
    ["part", "tool_name"],
    ["part", "name"],
  ]);
}

function readOpenCodeToolInput(event: Record<string, unknown>): unknown {
  const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
  return event.input ?? event.args ?? event.arguments ?? event.params ?? event.command
    ?? part?.input ?? part?.args ?? part?.arguments ?? part?.params ?? part?.command;
}

function isTerminalTextOpenClawEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === "string" ? event.type : "";
  return type === "message" || type === "text" || type === "result" || type === "assistant";
}

function readOpenClawToolInput(event: Record<string, unknown>): unknown {
  return event.input ?? event.args ?? event.arguments ?? event.params ?? event.command;
}

function extractClaudePermissionDenials(event: Record<string, unknown>): Array<{
  toolName: string;
  toolInput?: Record<string, unknown>;
}> {
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  return denials.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const toolName = typeof record.tool_name === "string" && record.tool_name.trim()
      ? record.tool_name.trim()
      : "unknown";
    const toolInput = record.tool_input && typeof record.tool_input === "object"
      ? record.tool_input as Record<string, unknown>
      : undefined;
    return [{ toolName, toolInput }];
  });
}

function formatToolApprovalPreview(toolName: string, toolInput?: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput?.command === "string") {
    return `Bash: ${toolInput.command}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput ?? {})}`;
}
