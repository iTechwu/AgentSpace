// Reusable per-session DeepSeek Harness JSON-RPC protocol state machine.
// Shared by the one-shot path (deepseek-jsonrpc.ts) and the bounded worker.
import type { AgentRouterDiagnostic, AgentRouterEvent, AgentRouterObserver } from "./types.ts";
import { createDiagnostic, extractText } from "./utils.ts";
import { randomUUID } from "node:crypto";

const JSONRPC_VERSION = "2.0";
const STEP_SCOPED_EVENT_TYPES = new Set(["assistant/chunk", "assistant/message", "tool/call", "tool/result"]);
const IGNORED_SESSION_EVENT_TYPES = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "feedback/record", "goal/change", "hook/invoked", "hook/result",
  "permission/preset", "plan/mode", "request/context", "request/header",
  "sandbox/mode", "schedule/change", "session/end-seed", "session/title",
  "session/title-llm-request", "todo/write", "user/message", "web/deepseek-search-llm-request",
]);

export interface DeepSeekSessionProtocolOptions {
  sessionId: string;
  prompt: string;
  environment?: Readonly<Record<string, string>>;
  cwd?: string;
  writeStdin: (data: string) => void;
  fail: (message: string) => void;
}

export class DeepSeekSessionProtocol {
  readonly diagnostics: AgentRouterDiagnostic[] = [];
  outputText?: string;
  private readonly promptId = "prompt-" + randomUUID();
  private readonly cancelId = "cancel-" + randomUUID();
  private readonly toolNames = new Map<string, string>();
  private readonly streamedTextSteps = new Set<string>();
  private readonly usageByStep = new Map<string, ValidTokenUsage>();
  private readonly emittedUsageSteps = new Set<string>();
  private readonly chunkStates = new Map<string, StreamChunkState>();
  private readonly retryOwners = new Map<string, { stepKey: string; lastRetry: number }>();
  private readonly pendingEvents: Record<string, unknown>[] = [];
  private promptAccepted = false;
  private promptMessageId: string | undefined;
  private promptReceiptSeen = false;
  private turnEndKind: string | undefined;
  private idle = false;
  private protocolFailed = false;
  private lastRootEventSeq = -1;
  private openTurn: number | undefined;
  private openStep: number | undefined;
  private lastStep = 0;
  private pendingRetry: { retryId: string; retry: number; stepKey: string } | undefined;

  private readonly options: DeepSeekSessionProtocolOptions;

  constructor(options: DeepSeekSessionProtocolOptions) {
    this.options = options;
  }

  sendPrompt(): void {
    const params: Record<string, unknown> = {
      sessionId: this.options.sessionId,
      contentBlocks: [{ type: "text", text: this.options.prompt }],
    };
    if (this.options.environment !== undefined) params.environment = this.options.environment;
    if (this.options.cwd !== undefined) params.cwd = this.options.cwd;
    this.write("session/prompt", this.promptId, params);
  }

  cancel(): void {
    if (!this.promptAccepted || this.protocolFailed || this.turnEndKind !== undefined) return;
    this.write("session/cancel", this.cancelId, { sessionId: this.options.sessionId, reason: "operator", keepInbox: false });
  }

  consumeLine(line: string, observer: AgentRouterObserver): void {
    if (this.protocolFailed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
      message = parsed as Record<string, unknown>;
    } catch (error) {
      this.failProtocol("DeepSeek Harness JSON-RPC emitted an invalid frame: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    if (message.jsonrpc !== JSONRPC_VERSION) {
      this.failProtocol("DeepSeek Harness JSON-RPC emitted a frame with an unsupported protocol version.");
      return;
    }
    if ("id" in message) {
      this.handleResponse(message, observer);
      return;
    }
    if (typeof message.method !== "string") {
      this.failProtocol("DeepSeek Harness JSON-RPC emitted a frame without a method or response id.");
      return;
    }
    this.handleNotification(message.method, message.params, observer);
  }

  ownsResponse(id: string): boolean {
    return id === this.promptId || id === this.cancelId;
  }

  isTurnComplete(): boolean {
    return !this.protocolFailed
      && this.promptAccepted
      && this.promptReceiptSeen
      && (this.turnEndKind === "completed" || this.turnEndKind === "max-tokens")
      && this.idle;
  }

  private write(method: string, id: string, params?: Record<string, unknown>): void {
    const message: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method };
    if (params !== undefined) message.params = params;
    this.options.writeStdin(JSON.stringify(message) + String.fromCharCode(10));
  }

  private handleResponse(message: Record<string, unknown>, observer: AgentRouterObserver): void {
    const id = message.id;
    if (typeof id !== "string") {
      this.failProtocol("DeepSeek Harness JSON-RPC response id must be a string.");
      return;
    }
    if (message.error !== undefined) {
      this.failProtocol("DeepSeek Harness JSON-RPC request failed: " + (extractText(message.error) ?? "unknown JSON-RPC error"));
      return;
    }
    if (!("result" in message)) {
      this.failProtocol("DeepSeek Harness JSON-RPC response has neither result nor error.");
      return;
    }
    if (id === this.promptId) {
      if (this.promptAccepted) {
        this.failProtocol("DeepSeek Harness JSON-RPC returned a duplicate or out-of-order prompt response.");
        return;
      }
      const messageId = readNestedString(message.result, ["messageId"]);
      if (!messageId) {
        this.failProtocol("DeepSeek Harness JSON-RPC prompt response omitted messageId.");
        return;
      }
      this.promptAccepted = true;
      this.promptMessageId = messageId;
      this.flushPendingEvents(observer);
      return;
    }
    if (id === this.cancelId) {
      const result = asRecord(message.result);
      if (!result || result.cancelled !== true) {
        this.failProtocol("DeepSeek Harness JSON-RPC cancellation response was invalid.");
      }
      return;
    }
    this.failProtocol("DeepSeek Harness JSON-RPC returned an unknown response id: " + id);
  }

  private handleNotification(method: string, rawParams: unknown, observer: AgentRouterObserver): void {
    const params = asRecord(rawParams);
    if (!params) {
      this.failProtocol("DeepSeek Harness JSON-RPC notification " + method + " has invalid params.");
      return;
    }
    if (method === "session.status") {
      if (params.sessionId !== this.options.sessionId) return;
      if (params.status !== "idle" && params.status !== "running") {
        this.failProtocol("DeepSeek Harness JSON-RPC session.status has an invalid status.");
        return;
      }
      if (params.status === "idle") this.idle = true;
      return;
    }
    if (method === "subagent.started" || method === "subagent.finished") {
      if (params.parentSessionId === this.options.sessionId) {
        this.failProtocol("DeepSeek Harness JSON-RPC subagent notifications are not enabled for the bounded worker.");
      }
      return;
    }
    if (method === "approval.request") {
      if (params.sessionId !== this.options.sessionId) return;
      observer.emit({
        type: "approval_requested",
        toolName: typeof params.toolName === "string" ? params.toolName : "tool",
        contentPreview: typeof params.reason === "string" ? params.reason : "",
      });
      return;
    }
    if (method !== "session.event") {
      this.failProtocol("DeepSeek Harness JSON-RPC emitted an unsupported notification: " + method);
      return;
    }
    if (params.sessionId !== this.options.sessionId) return;
    const event = asRecord(params.event);
    if (!event || typeof event.type !== "string") {
      this.failProtocol("DeepSeek Harness JSON-RPC session.event has an invalid event envelope.");
      return;
    }
    const seq = event.seq;
    const time = event.time;
    if (!Number.isSafeInteger(seq) || (seq as number) !== this.lastRootEventSeq + 1 || typeof time !== "number" || !Number.isFinite(time)) {
      this.failProtocol("DeepSeek Harness JSON-RPC session.event has a non-contiguous seq or invalid time.");
      return;
    }
    this.lastRootEventSeq = seq as number;
    if (!this.promptAccepted) {
      this.pendingEvents.push(event);
      return;
    }
    this.consumeOwnedEvent(event, observer);
  }

  private consumeOwnedEvent(event: Record<string, unknown>, observer: AgentRouterObserver): void {
    if (this.protocolFailed) return;
    if (!this.promptReceiptSeen) {
      if (!isPromptReceipt(event, this.promptMessageId)) {
        this.failProtocol("DeepSeek Harness JSON-RPC emitted root-session activity before the owned prompt receipt.");
        return;
      }
      this.promptReceiptSeen = true;
      return;
    }
    const type = event.type;
    const data = asRecord(event.data);
    if (this.turnEndKind) {
      this.failProtocol("DeepSeek Harness JSON-RPC emitted root-session activity after turn/end.");
      return;
    }
    if (type === "turn/start") {
      if (!data || data.turn !== 1 || this.openTurn !== undefined || this.openStep !== undefined) {
        this.failProtocol("DeepSeek Harness JSON-RPC turn/start has an invalid or duplicate turn.");
        return;
      }
      this.openTurn = 1;
      return;
    }
    if (type === "step/start") {
      if (!data || data.turn !== this.openTurn || !isPositiveSafeInteger(data.step) || data.step !== this.lastStep + 1 || this.openStep !== undefined) {
        this.failProtocol("DeepSeek Harness JSON-RPC step/start does not match the active turn/step sequence.");
        return;
      }
      this.openStep = data.step as number;
      this.lastStep = this.openStep;
      return;
    }
    if (type === "step/end") {
      const chunkState = data ? this.chunkStates.get(stepKey(data)) : undefined;
      if (!data || data.turn !== this.openTurn || data.step !== this.openStep || this.pendingRetry || chunkState?.messageSeen !== true) {
        this.failProtocol("DeepSeek Harness JSON-RPC step/end does not match the active turn/step.");
        return;
      }
      this.openStep = undefined;
      return;
    }
    if (type === "llm/retry") {
      if (!data || data.turn !== this.openTurn || data.step !== this.openStep || !isValidRetryEventData(data) || this.pendingRetry) {
        this.failProtocol("DeepSeek Harness JSON-RPC llm/retry has an invalid or out-of-order payload.");
        return;
      }
      const key = stepKey(data);
      const chunkState = this.chunkStates.get(key);
      const retryId = data.retryId as string;
      const retry = data.retry as number;
      const retryOwner = this.retryOwners.get(retryId);
      if (!chunkState?.finished || chunkState.messageSeen || (chunkState.finishKind !== "error" && chunkState.finishKind !== "aborted")) {
        this.failProtocol("DeepSeek Harness JSON-RPC llm/retry did not follow a failed terminal attempt.");
        return;
      }
      if ((retryOwner && (retryOwner.stepKey !== key || retry !== retryOwner.lastRetry + 1)) || (!retryOwner && retry !== 1)) {
        this.failProtocol("DeepSeek Harness JSON-RPC llm/retry did not continue its retry chain.");
        return;
      }
      this.retryOwners.set(retryId, { stepKey: key, lastRetry: retry });
      this.pendingRetry = { retryId, retry, stepKey: key };
      return;
    }
    if (type === "llm/retry-started") {
      if (!data || data.turn !== this.openTurn || data.step !== this.openStep || !isPositiveSafeInteger(data.retry)
        || typeof data.retryId !== "string" || !data.retryId.trim()
        || !this.pendingRetry || this.pendingRetry.retryId !== data.retryId || this.pendingRetry.retry !== data.retry
        || this.pendingRetry.stepKey !== stepKey(data)) {
        this.failProtocol("DeepSeek Harness JSON-RPC llm/retry-started did not match its scheduled retry.");
        return;
      }
      this.chunkStates.delete(this.pendingRetry.stepKey);
      this.usageByStep.delete(this.pendingRetry.stepKey);
      this.emittedUsageSteps.delete(this.pendingRetry.stepKey);
      this.streamedTextSteps.delete(this.pendingRetry.stepKey);
      this.pendingRetry = undefined;
      return;
    }
    if (event.type === "turn/end") {
      const kind = readNestedString(data, ["reason", "kind"]);
      if (!data || data.turn !== this.openTurn || this.openStep !== undefined || !kind) {
        this.failProtocol("DeepSeek Harness JSON-RPC turn/end does not match the active turn or data.reason.kind.");
        return;
      }
      this.turnEndKind = kind;
      if (kind !== "completed" && kind !== "max-tokens") {
        this.failProtocol("DeepSeek Harness JSON-RPC turn ended unsuccessfully: " + kind);
        return;
      }
      this.openTurn = undefined;
      return;
    }
    if (STEP_SCOPED_EVENT_TYPES.has(String(type))) {
      if (!data || data.turn !== this.openTurn || data.step !== this.openStep) {
        this.failProtocol("DeepSeek Harness JSON-RPC " + String(type) + " does not match the active turn/step.");
        return;
      }
    }
    const mapped = mapSessionEvent(event, this.toolNames, this.streamedTextSteps, this.usageByStep, this.emittedUsageSteps, this.chunkStates);
    if (mapped.error) {
      this.failProtocol(mapped.error);
      return;
    }
    if (mapped.outputText !== undefined) this.outputText = mapped.outputText;
    for (const routerEvent of mapped.events) observer.emit(routerEvent);
  }

  private flushPendingEvents(observer: AgentRouterObserver): void {
    for (const event of this.pendingEvents.splice(0)) {
      if (this.protocolFailed) break;
      this.consumeOwnedEvent(event, observer);
    }
  }

  private failProtocol(message: string): void {
    if (!this.diagnostics.some((diagnostic) => diagnostic.message === message)) {
      this.diagnostics.push(createDiagnostic("harness.protocol_parse_failed", message, { severity: "error" }));
    }
    this.protocolFailed = true;
    this.options.fail(message);
  }
}function mapSessionEvent(
  event: Record<string, unknown>,
  toolNames: Map<string, string>,
  streamedTextSteps: Set<string>,
  usageByStep: Map<string, ValidTokenUsage>,
  emittedUsageSteps: Set<string>,
  chunkStates: Map<string, StreamChunkState>,
): { events: AgentRouterEvent[]; outputText?: string; error?: string } {
  const type = event.type;
  const data = asRecord(event.data);
  if (!data) {
    return typeof type === "string" && ["assistant/chunk", "assistant/message", "tool/call", "tool/result"].includes(type)
      ? { events: [], error: `DeepSeek Harness JSON-RPC ${type} has an invalid data payload.` }
      : { events: [] };
  }

  if (type === "assistant/chunk") {
    const chunk = asRecord(data.chunk);
    if (!hasValidTurnStep(data) || !chunk || typeof chunk.type !== "string") {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/chunk has an invalid data.chunk payload." };
    }
    const invalidChunk = { events: [], error: "DeepSeek Harness JSON-RPC assistant/chunk has an invalid data.chunk payload." };
    const key = stepKey(data);
    const chunkState = chunkStates.get(key) ?? {
      openBlocks: new Map<number, string>(),
      finished: false,
      messageSeen: false,
      finishKind: undefined,
      textDeltas: [],
    };
    chunkStates.set(key, chunkState);
    if (chunkState.finished) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/chunk was emitted after the terminal finish chunk." };
    }
    if (chunk.type === "block-start") {
      if (!isChunkIndex(chunk.index) || !isContentBlockType(chunk.blockType) || chunkState.openBlocks.has(chunk.index)) {
        return invalidChunk;
      }
      chunkState.openBlocks.set(chunk.index, chunk.blockType);
      return { events: [] };
    }
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      const expectedBlock = chunk.type === "text-delta" ? "text" : "reasoning";
      if (!isChunkIndex(chunk.index) || chunkState.openBlocks.get(chunk.index) !== expectedBlock || typeof chunk.text !== "string") {
        return invalidChunk;
      }
      if (chunk.type === "reasoning-delta" || !chunk.text) return { events: [] };
      chunkState.textDeltas.push(chunk.text);
      return { events: [] };
    }
    if (chunk.type === "tool-call-delta") {
      return isChunkIndex(chunk.index)
        && chunkState.openBlocks.get(chunk.index) === "tool-call"
        && typeof chunk.id === "string" && chunk.id.trim()
        && (chunk.name === undefined || typeof chunk.name === "string")
        && typeof chunk.argumentsDelta === "string"
        ? { events: [] }
        : invalidChunk;
    }
    if (chunk.type === "block-end") {
      const block = asRecord(chunk.block);
      if (!isChunkIndex(chunk.index) || !block || chunkState.openBlocks.get(chunk.index) !== block.type || !isValidContentBlock(block)) {
        return invalidChunk;
      }
      chunkState.openBlocks.delete(chunk.index);
      return { events: [] };
    }
    if (chunk.type === "usage") {
      const usage = parseTokenUsage(chunk.usage);
      const previous = usageByStep.get(key);
      if (!usage || (previous !== undefined && !tokenUsageEquals(previous, usage))) {
        return { events: [], error: "DeepSeek Harness JSON-RPC assistant/chunk usage has an invalid payload." };
      }
      usageByStep.set(key, usage);
      return { events: [] };
    }
    if (chunk.type === "finish") {
      const reason = asRecord(chunk.reason);
      if (chunkState.openBlocks.size > 0 || !isValidFinishReason(reason)) return invalidChunk;
      chunkState.finished = true;
      chunkState.finishKind = reason?.kind as string;
      if (reason?.kind === "error" || reason?.kind === "aborted" || chunkState.textDeltas.length === 0) {
        return { events: [] };
      }
      streamedTextSteps.add(key);
      return { events: chunkState.textDeltas.map((text) => ({ type: "text_delta", text })) };
    }
    return invalidChunk;
  }

  if (type === "assistant/message") {
    const content = asRecord(data.message)?.content ?? data.content;
    if (!hasValidTurnStep(data) || !isValidAssistantContent(content)) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message has an invalid content payload." };
    }
    const text = extractAssistantText(content);
    const key = stepKey(data);
    const chunkState = chunkStates.get(key) ?? {
      openBlocks: new Map<number, string>(),
      finished: false,
      messageSeen: false,
      finishKind: undefined,
      textDeltas: [],
    };
    if (chunkState.messageSeen || (chunkStates.has(key) && !chunkState.finished)) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message was duplicate or preceded the terminal finish chunk." };
    }
    chunkState.messageSeen = true;
    chunkStates.set(key, chunkState);
    const mapped: AgentRouterEvent[] = text && !streamedTextSteps.has(key)
      ? [{ type: "narration_delta", text }]
      : [];
    const streamedUsage = usageByStep.get(key);
    const usage = data.usage === undefined ? undefined : parseTokenUsage(data.usage);
    if (data.usage !== undefined && !usage) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message has an invalid usage payload." };
    }
    if (streamedUsage && !usage) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message omitted its streamed usage." };
    }
    if (streamedUsage && usage && !tokenUsageEquals(streamedUsage, usage)) {
      return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message usage conflicts with its streamed usage." };
    }
    const canonicalUsage = usage ?? streamedUsage;
    if (canonicalUsage) {
      if (emittedUsageSteps.has(key)) {
        return { events: [], error: "DeepSeek Harness JSON-RPC assistant/message repeated usage for the same step." };
      }
      emittedUsageSteps.add(key);
      usageByStep.set(key, canonicalUsage);
      mapped.push(usageEvent(canonicalUsage));
    }
    return { events: mapped, outputText: text };
  }

  if (type === "tool/call") {
    const callId = typeof data.callId === "string" ? data.callId : undefined;
    const name = typeof data.name === "string" && data.name.trim() ? data.name : "unknown";
    if (!hasValidTurnStep(data) || !callId?.trim() || name === "unknown" || typeof data.arguments !== "string") {
      return { events: [], error: "DeepSeek Harness JSON-RPC tool/call has an invalid payload." };
    }
    toolNames.set(callId, name);
    return { events: [{
      type: "tool_started",
      tool: name,
      title: name,
      input: parseToolArguments(data.arguments),
      toolUseId: callId,
    }] };
  }

  if (type === "tool/result") {
    const message = asRecord(data.message);
    const callId = readNestedString(message?.source, ["callId"]);
    const content = message?.content;
    const tool = callId ? toolNames.get(callId) : undefined;
    if (!hasValidTurnStep(data) || !callId || !tool || !Array.isArray(content) || !content.every((item) => {
      const block = asRecord(item);
      return block !== undefined && isValidContentBlock(block);
    })) {
      return { events: [], error: "DeepSeek Harness JSON-RPC tool/result has an invalid or unowned payload." };
    }
    const output = extractText(content);
    const isError = data.error !== undefined || readNestedBoolean(message?.content, [0, "isError"]) === true;
    return { events: [
      { type: "tool_output", tool, output, toolUseId: callId },
      { type: "tool_finished", tool, status: isError ? "failed" : "completed", toolUseId: callId },
    ] };
  }

  if (event.ignorable === true || (typeof type === "string" && IGNORED_SESSION_EVENT_TYPES.has(type))) {
    return { events: [] };
  }
  return {
    events: [],
    error: `DeepSeek Harness JSON-RPC emitted an unsupported required session event: ${String(type)}.`,
  };
}

function isPromptReceipt(event: Record<string, unknown>, messageId: string | undefined): boolean {
  if (!messageId || event.type !== "agent/inbox/spliced") return false;
  const inserted = asRecord(event.data)?.inserted;
  return Array.isArray(inserted) && inserted.some((message) => asRecord(message)?.id === messageId);
}

function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
  return text.trim() ? text : undefined;
}

function isValidAssistantContent(content: unknown): content is unknown[] {
  return Array.isArray(content) && content.every((block) => {
    const record = asRecord(block);
    return record !== undefined && isValidContentBlock(record);
  });
}

function hasValidTurnStep(data: Record<string, unknown>): boolean {
  return isPositiveSafeInteger(data.turn) && isPositiveSafeInteger(data.step);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

interface ValidTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface StreamChunkState {
  openBlocks: Map<number, string>;
  finished: boolean;
  messageSeen: boolean;
  finishKind?: string;
  textDeltas: string[];
}

function parseTokenUsage(value: unknown): ValidTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage || !isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens)) return undefined;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;
  const reasoningTokens = usage.reasoningTokens;
  if (cacheReadTokens !== undefined && !isTokenCount(cacheReadTokens)) return undefined;
  if (cacheWriteTokens !== undefined && !isTokenCount(cacheWriteTokens)) return undefined;
  if (reasoningTokens !== undefined && !isTokenCount(reasoningTokens)) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function usageEvent(usage: ValidTokenUsage): AgentRouterEvent {
  return {
    type: "tool_output",
    tool: "usage",
    metadata: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cache_write_tokens: usage.cacheWriteTokens }),
      ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
    },
  };
}

function tokenUsageEquals(left: ValidTokenUsage, right: ValidTokenUsage): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.reasoningTokens === right.reasoningTokens;
}

function isContentBlockType(value: unknown): value is string {
  return typeof value === "string"
    && ["text", "reasoning", "image", "tool-call", "tool-result"].includes(value);
}

function isValidContentBlock(block: Record<string, unknown>): boolean {
  if (block.type === "text" || block.type === "reasoning") return typeof block.text === "string";
  if (block.type === "image") return asRecord(block.attachment) !== undefined;
  if (block.type === "tool-call") {
    return typeof block.id === "string" && Boolean(block.id.trim())
      && typeof block.name === "string" && Boolean(block.name.trim())
      && typeof block.arguments === "string";
  }
  if (block.type === "tool-result") {
    return typeof block.toolCallId === "string" && Boolean(block.toolCallId.trim())
      && Array.isArray(block.content) && block.content.every((item) => {
        const nested = asRecord(item);
        return nested !== undefined && isValidContentBlock(nested);
      })
      && (block.isError === undefined || typeof block.isError === "boolean");
  }
  return false;
}

function isValidFinishReason(reason: Record<string, unknown> | undefined): boolean {
  if (!reason) return false;
  if (reason.kind === "stop" || reason.kind === "tool-calls" || reason.kind === "max-tokens") return true;
  if (reason.kind !== "error" && reason.kind !== "aborted") return false;
  return isValidLlmFailure(reason.failure);
}

function isValidRetryEventData(data: Record<string, unknown>): boolean {
  if (typeof data.retryId !== "string" || !data.retryId.trim()
    || data.provider !== "deepseek-official"
    || typeof data.policyKey !== "string" || !data.policyKey.trim()
    || !isPositiveSafeInteger(data.retry)
    || typeof data.delayMs !== "number" || !Number.isFinite(data.delayMs)
    || data.delayMs < 0 || data.delayMs > 2_147_483_647
    || !isValidLlmFailure(data.failure)) {
    return false;
  }
  if (data.mode === "normal") {
    return isPositiveSafeInteger(data.maxRetries) && (data.retry as number) <= (data.maxRetries as number);
  }
  return data.mode === "always" && data.maxRetries === undefined;
}

function isValidLlmFailure(value: unknown): boolean {
  const failure = asRecord(value);
  return typeof failure?.message === "string" && Boolean(failure.message.trim())
    && typeof failure.code === "string" && Boolean(failure.code.trim())
    && (failure.status === undefined || (Number.isSafeInteger(failure.status) && (failure.status as number) > 0))
    && (failure.providerRetryAfterMs === undefined
      || (typeof failure.providerRetryAfterMs === "number"
        && Number.isFinite(failure.providerRetryAfterMs)
        && failure.providerRetryAfterMs > 0))
    && (failure.requestId === undefined || (typeof failure.requestId === "string" && Boolean(failure.requestId.trim())));
}

function isChunkIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stepKey(data: Record<string, unknown>): string {
  return `${String(data.turn ?? "")}:${String(data.step ?? "")}`;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNestedString(value: unknown, path: Array<string | number>): string | undefined {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
      continue;
    }
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[segment];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined;
}

function readNestedBoolean(value: unknown, path: Array<string | number>): boolean | undefined {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
      continue;
    }
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[segment];
  }
  return typeof cursor === "boolean" ? cursor : undefined;
}
