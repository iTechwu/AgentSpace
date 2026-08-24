import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  AgentRouterDiagnostic,
  AgentRouterEvent,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessLaunchPlan,
} from "../types.ts";
import type { HarnessProcessController } from "../subprocess.ts";
import { buildCapabilityEnv, buildCapabilityPathDirs } from "../capabilities.ts";
import {
  stripDeepSeekJsonRpcUnsafeEnvironment,
  verifyDeepSeekJsonRpcPinnedArtifacts,
} from "../deepseek-jsonrpc-release.ts";
import {
  buildBaseEnv,
  buildRedactions,
  createDiagnostic,
  extractText,
  findExecutableOnPath,
  resolveExecutablePath,
  resolveTimeoutMs,
} from "../utils.ts";
import { runNativeHarness } from "./shared.ts";

const JSONRPC_VERSION = "2.0";
const SERVER_INFO = { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } as const;
const SHUTDOWN_RESPONSE_TIMEOUT_MS = 1_000;
const SHUTDOWN_EXIT_GRACE_MS = 1_000;
const MAX_JSONRPC_FRAME_BYTES = 1024 * 1024;
const STEP_SCOPED_EVENT_TYPES = new Set(["assistant/chunk", "assistant/message", "tool/call", "tool/result"]);
const IGNORED_SESSION_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "todo/write",
  "user/message",
  "web/deepseek-search-llm-request",
]);
const DEEPSEEK_RELEASE_VERIFICATION_ENVIRONMENT_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DSH_CORDIS_CONFIG",
  "DSH_CWD",
  "DSH_HOME",
  "DSH_SESSION_ROOT",
  "DSH_TELEMETRY_DISABLED",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export async function buildDeepSeekJsonRpcLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  if (input.sessionId?.trim()) {
    throw new Error("DeepSeek Harness one-shot JSON-RPC mode does not support cross-process session resume.");
  }
  if (input.deepSeekJsonRpcIsolatedEnvironment && !input.deepSeekJsonRpcReleasePolicy) {
    throw new Error("DeepSeek Harness environment isolation requires a verified release policy.");
  }
  let executable = input.executablePath?.trim()
    ? await resolveExecutablePath("deepseek-harness", input.executablePath)
    : await findExecutableOnPath("dsh-jsonrpc-agent");
  if (!executable) {
    throw new Error("DeepSeek Harness JSON-RPC runtime was not found on PATH.");
  }
  if (!input.model || !["deepseek-v4-flash", "deepseek-v4-pro"].includes(input.model)) {
    throw new Error(`DeepSeek Harness JSON-RPC model "${input.model ?? ""}" is not supported.`);
  }

  const configuredPath = input.env?.DSH_CORDIS_CONFIG?.trim();
  if (!configuredPath) {
    throw new Error("DeepSeek Harness JSON-RPC mode requires DSH_CORDIS_CONFIG.");
  }
  const requestedConfigPath = isAbsolute(configuredPath) ? configuredPath : resolve(input.cwd, configuredPath);
  let configPath: string;
  try {
    configPath = realpathSync(requestedConfigPath);
    if (!statSync(configPath).isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error(`DeepSeek Harness JSON-RPC Cordis config was not a regular file: ${requestedConfigPath}`);
  }
  if (input.deepSeekJsonRpcReleasePolicy) {
    const verified = verifyDeepSeekJsonRpcPinnedArtifacts({
      executablePath: executable,
      executableSha256: input.deepSeekJsonRpcReleasePolicy.executableSha256,
      cordisConfigPath: configPath,
      cordisConfigSha256: input.deepSeekJsonRpcReleasePolicy.cordisConfigSha256,
      ripgrepSha256: input.deepSeekJsonRpcReleasePolicy.ripgrepSha256,
      spawnHelperSha256: input.deepSeekJsonRpcReleasePolicy.spawnHelperSha256,
      provenancePath: input.deepSeekJsonRpcReleasePolicy.provenancePath,
      sourceCommit: input.deepSeekJsonRpcReleasePolicy.sourceCommit,
      wheelSha256: input.deepSeekJsonRpcReleasePolicy.wheelSha256,
    });
    executable = verified.executablePath;
    configPath = verified.cordisConfigPath;
  }
  const cwdPath = realpathSync(input.cwd);

  const invocationId = randomUUID();
  const configuredHome = input.env?.DSH_HOME?.trim();
  const runtimeHomePath = join(configuredHome || input.cwd, `.dofe-deepseek-harness-jsonrpc-${invocationId}`);
  const sessionRootPath = join(runtimeHomePath, "sessions");
  mkdirSync(sessionRootPath, { recursive: true, mode: 0o700 });

  const capabilityEnvironment = buildCapabilityEnv(input.env ?? {}, input.runtimeToolCapabilities);
  if (input.deepSeekJsonRpcReleasePolicy) {
    for (const key of Object.keys(capabilityEnvironment)) {
      if (key.toUpperCase() === "PATH") delete capabilityEnvironment[key];
    }
    capabilityEnvironment.PATH = process.env.PATH ?? process.env.Path ?? "";
  }
  let env = buildBaseEnv(
    executable,
    {
      ...stripDeepSeekJsonRpcUnsafeEnvironment(capabilityEnvironment),
      DSH_CORDIS_CONFIG: configPath,
      DSH_CWD: cwdPath,
      DSH_HOME: runtimeHomePath,
      DSH_SESSION_ROOT: sessionRootPath,
      DSH_TELEMETRY_DISABLED: "1",
    },
    buildCapabilityPathDirs(input.runtimeToolCapabilities),
  );
  if (input.deepSeekJsonRpcReleasePolicy) {
    env = stripDeepSeekJsonRpcUnsafeEnvironment(env);
  }
  if (input.deepSeekJsonRpcIsolatedEnvironment) {
    env = Object.fromEntries(
      Object.entries(env).filter(([key]) => DEEPSEEK_RELEASE_VERIFICATION_ENVIRONMENT_KEYS.has(key)),
    );
  }

  return {
    executable,
    args: [],
    cwd: input.cwd,
    env,
    metadata: { runtimeHomePath, executionMode: "jsonrpc" },
    keepStdinOpen: true,
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    redactions: buildRedactions(env),
  };
}

export async function runDeepSeekJsonRpc(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  const state = createProtocolState(request, plan);
  let stdoutBuffer = "";
  return runNativeHarness("deepseek-harness", plan, observer, request, {
    emptyMessage: "DeepSeek Harness JSON-RPC runtime returned no assistant response.",
    nonZeroMessage: (exitCode) => `DeepSeek Harness JSON-RPC runtime exited with code ${exitCode}.`,
    timeoutMessage: (timeoutMs) => `DeepSeek Harness JSON-RPC runtime timed out after ${timeoutMs}ms.`,
    onReady: (controller) => {
      state.controller = controller;
      state.send("initialize", {
        cwd: plan.env.DSH_CWD,
        provider: "deepseek-official",
        model: request.model,
      });
    },
    onStdout: (chunk, runObserver) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > MAX_JSONRPC_FRAME_BYTES) {
          state.fail("DeepSeek Harness JSON-RPC frame exceeded the 1 MiB size limit.");
          return;
        }
        state.consumeLine(line, runObserver);
      }
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSONRPC_FRAME_BYTES) {
        state.fail("DeepSeek Harness JSON-RPC frame exceeded the 1 MiB size limit.");
      }
    },
    onAbort: () => state.cancel(),
    acceptNonZeroExit: (processResult) =>
      (processResult.signal === "SIGTERM" || processResult.signal === "SIGKILL") && state.isComplete(),
    failureDiagnostics: () => state.diagnostics,
    includeStdoutInFailureDiagnostic: false,
    parseEvents: (_stdout, _stderr, runObserver) => {
      if (stdoutBuffer.trim()) {
        state.consumeLine(stdoutBuffer, runObserver);
        stdoutBuffer = "";
      }
      state.validateCompletion();
      return {
        outputText: state.outputText,
        diagnostics: state.diagnostics,
      };
    },
  });
}

interface JsonRpcProtocolState {
  controller?: HarnessProcessController;
  readonly diagnostics: AgentRouterDiagnostic[];
  outputText?: string;
  send(method: "initialize" | "session/prompt" | "session/cancel" | "shutdown", params?: Record<string, unknown>): void;
  cancel(): void;
  fail(message: string): void;
  consumeLine(line: string, observer: AgentRouterObserver): void;
  isComplete(): boolean;
  validateCompletion(): void;
}

function createProtocolState(request: AgentRouterRunRequest, plan: HarnessLaunchPlan): JsonRpcProtocolState {
  const initializeId = `initialize-${randomUUID()}`;
  const promptId = `prompt-${randomUUID()}`;
  const cancelId = `cancel-${randomUUID()}`;
  const shutdownId = `shutdown-${randomUUID()}`;
  const sessionId = `dofe-task-${randomUUID()}`;
  const diagnostics: AgentRouterDiagnostic[] = [];
  const toolNames = new Map<string, string>();
  const streamedTextSteps = new Set<string>();
  const usageByStep = new Map<string, ValidTokenUsage>();
  const emittedUsageSteps = new Set<string>();
  const chunkStates = new Map<string, StreamChunkState>();
  const retryOwners = new Map<string, { stepKey: string; lastRetry: number }>();
  const pendingEvents: Record<string, unknown>[] = [];
  let initialized = false;
  let promptAccepted = false;
  let promptMessageId: string | undefined;
  let promptReceiptSeen = false;
  let idle = false;
  let turnEndKind: string | undefined;
  let shutdownSent = false;
  let cancelSent = false;
  let shutdownCompleted = false;
  let shutdownResponseTimer: NodeJS.Timeout | undefined;
  let shutdownExitTimer: NodeJS.Timeout | undefined;
  let lastRootEventSeq = -1;
  let protocolFailed = false;
  let openTurn: number | undefined;
  let openStep: number | undefined;
  let lastStep = 0;
  let pendingRetry: { retryId: string; retry: number; stepKey: string } | undefined;

  const state: JsonRpcProtocolState = {
    diagnostics,
    send(method, params) {
      const id = method === "initialize"
        ? initializeId
        : method === "session/prompt" ? promptId : method === "session/cancel" ? cancelId : shutdownId;
      const message: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method };
      if (params !== undefined) message.params = params;
      state.controller?.writeStdin(`${JSON.stringify(message)}\n`);
    },
    fail(message) {
      failProtocol(message);
    },
    cancel() {
      if (!initialized || cancelSent || shutdownSent || protocolFailed) return;
      cancelSent = true;
      state.send("session/cancel", { sessionId, reason: "operator", keepInbox: false });
    },
    consumeLine(line, observer) {
      if (protocolFailed) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
        message = parsed as Record<string, unknown>;
      } catch (error) {
        failProtocol(`DeepSeek Harness JSON-RPC emitted an invalid frame: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (message.jsonrpc !== JSONRPC_VERSION) {
        failProtocol("DeepSeek Harness JSON-RPC emitted a frame with an unsupported protocol version.");
        return;
      }
      if ("id" in message) {
        handleResponse(message, observer);
        return;
      }
      if (typeof message.method !== "string") {
        failProtocol("DeepSeek Harness JSON-RPC emitted a frame without a method or response id.");
        return;
      }
      handleNotification(message.method, message.params, observer);
    },
    isComplete() {
      return !protocolFailed
        && initialized
        && promptAccepted
        && promptReceiptSeen
        && (turnEndKind === "completed" || turnEndKind === "max-tokens")
        && idle
        && shutdownCompleted;
    },
    validateCompletion() {
      clearTimeout(shutdownResponseTimer);
      clearTimeout(shutdownExitTimer);
      if (!initialized) failProtocol("DeepSeek Harness JSON-RPC initialization did not complete.", false);
      if (!promptAccepted) failProtocol("DeepSeek Harness JSON-RPC prompt was not acknowledged.", false);
      if (!promptReceiptSeen) failProtocol("DeepSeek Harness JSON-RPC prompt receipt was not observed.", false);
      if (!turnEndKind) failProtocol("DeepSeek Harness JSON-RPC turn did not emit a valid turn/end reason.", false);
      if (!idle) failProtocol("DeepSeek Harness JSON-RPC session did not reach idle.", false);
      if (!shutdownCompleted) failProtocol("DeepSeek Harness JSON-RPC shutdown did not complete.", false);
    },
  };

  function handleResponse(message: Record<string, unknown>, observer: AgentRouterObserver): void {
    const id = message.id;
    if (typeof id !== "string") {
      failProtocol("DeepSeek Harness JSON-RPC response id must be a string.");
      return;
    }
    if (message.error !== undefined) {
      const errorText = extractText(message.error) ?? "unknown JSON-RPC error";
      failProtocol(`DeepSeek Harness JSON-RPC request failed: ${errorText}`);
      return;
    }
    if (!("result" in message)) {
      failProtocol("DeepSeek Harness JSON-RPC response has neither result nor error.");
      return;
    }
    if (id === initializeId) {
      if (initialized || promptAccepted || shutdownSent) {
        failProtocol("DeepSeek Harness JSON-RPC returned a duplicate or out-of-order initialize response.");
        return;
      }
      const name = readNestedString(message.result, ["serverInfo", "name"]);
      const version = readNestedString(message.result, ["serverInfo", "version"]);
      if (name !== SERVER_INFO.name || version !== SERVER_INFO.version) {
        failProtocol("DeepSeek Harness JSON-RPC initialization returned an incompatible server identity.");
        return;
      }
      initialized = true;
      state.send("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text: request.prompt }],
      });
      return;
    }
    if (id === promptId) {
      if (!initialized || promptAccepted || shutdownSent) {
        failProtocol("DeepSeek Harness JSON-RPC returned a duplicate or out-of-order prompt response.");
        return;
      }
      const messageId = readNestedString(message.result, ["messageId"]);
      if (!messageId) {
        failProtocol("DeepSeek Harness JSON-RPC prompt response omitted messageId.");
        return;
      }
      promptAccepted = true;
      promptMessageId = messageId;
      flushPendingEvents(observer);
      maybeShutdown();
      return;
    }
    if (id === shutdownId) {
      if (!shutdownSent || shutdownCompleted) {
        failProtocol("DeepSeek Harness JSON-RPC returned a duplicate or out-of-order shutdown response.");
        return;
      }
      clearTimeout(shutdownResponseTimer);
      shutdownCompleted = true;
      beginEofExitGrace();
      return;
    }
    if (id === cancelId) {
      const result = asRecord(message.result);
      if (!cancelSent || !result || result.cancelled !== true) {
        failProtocol("DeepSeek Harness JSON-RPC cancellation response was invalid.");
      }
      return;
    }
    failProtocol(`DeepSeek Harness JSON-RPC returned an unknown response id: ${id}`);
  }

  function handleNotification(method: string, rawParams: unknown, observer: AgentRouterObserver): void {
    const params = asRecord(rawParams);
    if (!params) {
      failProtocol(`DeepSeek Harness JSON-RPC notification ${method} has invalid params.`);
      return;
    }
    if (method === "session.status") {
      if (params.sessionId !== sessionId) return;
      if (params.status !== "idle" && params.status !== "running") {
        failProtocol("DeepSeek Harness JSON-RPC session.status has an invalid status.");
        return;
      }
      if (params.status === "idle") {
        idle = true;
        maybeShutdown();
      }
      return;
    }
    if (method === "subagent.started" || method === "subagent.finished") {
      if (params.parentSessionId === sessionId) {
        failProtocol("DeepSeek Harness JSON-RPC subagent notifications are not enabled for the one-shot protocol spike.");
      }
      return;
    }
    if (method !== "session.event") {
      failProtocol(`DeepSeek Harness JSON-RPC emitted an unsupported notification: ${method}`);
      return;
    }
    if (params.sessionId !== sessionId) return;
    const event = asRecord(params.event);
    if (!event || typeof event.type !== "string") {
      failProtocol("DeepSeek Harness JSON-RPC session.event has an invalid event envelope.");
      return;
    }
    const seq = event.seq;
    const time = event.time;
    if (!Number.isSafeInteger(seq) || (seq as number) !== lastRootEventSeq + 1 || typeof time !== "number" || !Number.isFinite(time)) {
      failProtocol("DeepSeek Harness JSON-RPC session.event has a non-contiguous seq or invalid time.");
      return;
    }
    lastRootEventSeq = seq as number;
    if (!promptAccepted) {
      pendingEvents.push(event);
      return;
    }
    consumeOwnedEvent(event, observer);
  }

  function consumeOwnedEvent(event: Record<string, unknown>, observer: AgentRouterObserver): void {
    if (protocolFailed) return;
    if (!promptReceiptSeen) {
      if (!isPromptReceipt(event, promptMessageId)) {
        failProtocol("DeepSeek Harness JSON-RPC emitted root-session activity before the owned prompt receipt.");
        return;
      }
      promptReceiptSeen = true;
      maybeShutdown();
      return;
    }
    const type = event.type;
    const data = asRecord(event.data);
    if (turnEndKind) {
      failProtocol("DeepSeek Harness JSON-RPC emitted root-session activity after turn/end.");
      return;
    }
    if (type === "turn/start") {
      if (!data || data.turn !== 1 || openTurn !== undefined || openStep !== undefined) {
        failProtocol("DeepSeek Harness JSON-RPC turn/start has an invalid or duplicate turn.");
        return;
      }
      openTurn = 1;
      return;
    }
    if (type === "step/start") {
      if (!data || data.turn !== openTurn || !isPositiveSafeInteger(data.step) || data.step !== lastStep + 1 || openStep !== undefined) {
        failProtocol("DeepSeek Harness JSON-RPC step/start does not match the active turn/step sequence.");
        return;
      }
      openStep = data.step as number;
      lastStep = openStep;
      return;
    }
    if (type === "step/end") {
      const chunkState = data ? chunkStates.get(stepKey(data)) : undefined;
      if (!data || data.turn !== openTurn || data.step !== openStep || pendingRetry || chunkState?.messageSeen !== true) {
        failProtocol("DeepSeek Harness JSON-RPC step/end does not match the active turn/step.");
        return;
      }
      openStep = undefined;
      return;
    }
    if (type === "llm/retry") {
      if (!data || data.turn !== openTurn || data.step !== openStep || !isValidRetryEventData(data) || pendingRetry) {
        failProtocol("DeepSeek Harness JSON-RPC llm/retry has an invalid or out-of-order payload.");
        return;
      }
      const key = stepKey(data);
      const chunkState = chunkStates.get(key);
      const retryId = data.retryId as string;
      const retry = data.retry as number;
      const retryOwner = retryOwners.get(retryId);
      if (!chunkState?.finished || chunkState.messageSeen
        || (chunkState.finishKind !== "error" && chunkState.finishKind !== "aborted")) {
        failProtocol("DeepSeek Harness JSON-RPC llm/retry did not follow a failed terminal attempt.");
        return;
      }
      if ((retryOwner && (retryOwner.stepKey !== key || retry !== retryOwner.lastRetry + 1))
        || (!retryOwner && retry !== 1)) {
        failProtocol("DeepSeek Harness JSON-RPC llm/retry did not continue its retry chain.");
        return;
      }
      retryOwners.set(retryId, { stepKey: key, lastRetry: retry });
      pendingRetry = { retryId, retry, stepKey: key };
      return;
    }
    if (type === "llm/retry-started") {
      if (!data || data.turn !== openTurn || data.step !== openStep || !isPositiveSafeInteger(data.retry)
        || typeof data.retryId !== "string" || !data.retryId.trim()
        || !pendingRetry || pendingRetry.retryId !== data.retryId || pendingRetry.retry !== data.retry
        || pendingRetry.stepKey !== stepKey(data)) {
        failProtocol("DeepSeek Harness JSON-RPC llm/retry-started did not match its scheduled retry.");
        return;
      }
      chunkStates.delete(pendingRetry.stepKey);
      usageByStep.delete(pendingRetry.stepKey);
      emittedUsageSteps.delete(pendingRetry.stepKey);
      streamedTextSteps.delete(pendingRetry.stepKey);
      pendingRetry = undefined;
      return;
    }
    if (event.type === "turn/end") {
      const kind = readNestedString(data, ["reason", "kind"]);
      if (!data || data.turn !== openTurn || openStep !== undefined || !kind) {
        failProtocol("DeepSeek Harness JSON-RPC turn/end does not match the active turn or data.reason.kind.");
        return;
      }
      turnEndKind = kind;
      if (kind !== "completed" && kind !== "max-tokens") {
        failProtocol(`DeepSeek Harness JSON-RPC turn ended unsuccessfully: ${kind}`);
        return;
      }
      openTurn = undefined;
      maybeShutdown();
      return;
    }
    if (STEP_SCOPED_EVENT_TYPES.has(String(type))) {
      if (!data || data.turn !== openTurn || data.step !== openStep) {
        failProtocol(`DeepSeek Harness JSON-RPC ${String(type)} does not match the active turn/step.`);
        return;
      }
    }
    const mapped = mapSessionEvent(event, toolNames, streamedTextSteps, usageByStep, emittedUsageSteps, chunkStates);
    if (mapped.error) {
      failProtocol(mapped.error);
      return;
    }
    if (mapped.outputText !== undefined) state.outputText = mapped.outputText;
    for (const routerEvent of mapped.events) {
      observer.emit(routerEvent);
    }
    maybeShutdown();
  }

  function flushPendingEvents(observer: AgentRouterObserver): void {
    for (const event of pendingEvents.splice(0)) {
      if (protocolFailed) break;
      consumeOwnedEvent(event, observer);
    }
  }

  function maybeShutdown(): void {
    if (!promptAccepted || !promptReceiptSeen || !turnEndKind || !idle || shutdownSent) return;
    shutdownSent = true;
    state.send("shutdown");
    shutdownResponseTimer = setTimeout(() => {
      failProtocol("DeepSeek Harness JSON-RPC shutdown response timed out.", false);
      beginEofExitGrace();
    }, SHUTDOWN_RESPONSE_TIMEOUT_MS);
    shutdownResponseTimer.unref();
  }

  function beginEofExitGrace(): void {
    state.controller?.closeStdin();
    clearTimeout(shutdownExitTimer);
    shutdownExitTimer = setTimeout(() => state.controller?.terminate(), SHUTDOWN_EXIT_GRACE_MS);
    shutdownExitTimer.unref();
  }

  function failProtocol(message: string, terminate = true): void {
    if (!diagnostics.some((diagnostic) => diagnostic.message === message)) {
      diagnostics.push(createDiagnostic("harness.protocol_parse_failed", message, { severity: "error" }));
    }
    protocolFailed = true;
    clearTimeout(shutdownResponseTimer);
    clearTimeout(shutdownExitTimer);
    if (!terminate) return;
    state.controller?.closeStdin();
    state.controller?.terminate();
  }

  return state;
}

function mapSessionEvent(
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
