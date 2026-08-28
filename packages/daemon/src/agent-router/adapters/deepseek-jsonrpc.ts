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
import { DeepSeekSessionProtocol } from "../deepseek-jsonrpc-protocol.ts";

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
        protocolVersions: [JSONRPC_VERSION],
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
  readonly outputText?: string;
  send(method: "initialize" | "shutdown", params?: Record<string, unknown>): void;
  cancel(): void;
  fail(message: string): void;
  consumeLine(line: string, observer: AgentRouterObserver): void;
  isComplete(): boolean;
  validateCompletion(): void;
}


function createProtocolState(request: AgentRouterRunRequest, plan: HarnessLaunchPlan): JsonRpcProtocolState {
  const initializeId = "initialize-" + randomUUID();
  const shutdownId = "shutdown-" + randomUUID();
  const sessionId = "dofe-task-" + randomUUID();
  const diagnostics: AgentRouterDiagnostic[] = [];
  let initialized = false;
  let shutdownSent = false;
  let shutdownCompleted = false;
  let shutdownResponseTimer: NodeJS.Timeout | undefined;
  let shutdownExitTimer: NodeJS.Timeout | undefined;
  let protocolFailed = false;

  const baseUrl = plan.env.DEEPSEEK_BASE_URL;
  const sessionProtocol = new DeepSeekSessionProtocol({
    sessionId,
    prompt: request.prompt,
    ...(baseUrl ? { environment: { DEEPSEEK_BASE_URL: baseUrl } } : {}),
    writeStdin: (data) => state.controller?.writeStdin(data),
    fail: (message) => failProtocol(message),
  });

  const state: JsonRpcProtocolState = {
    diagnostics,
    get outputText() {
      return sessionProtocol.outputText;
    },
    send(method, params) {
      const id = method === "initialize" ? initializeId : shutdownId;
      const message: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method };
      if (params !== undefined) message.params = params;
      state.controller?.writeStdin(JSON.stringify(message) + String.fromCharCode(10));
    },
    fail(message) {
      failProtocol(message);
    },
    cancel() {
      sessionProtocol.cancel();
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
        failProtocol("DeepSeek Harness JSON-RPC emitted an invalid frame: " + (error instanceof Error ? error.message : String(error)));
        return;
      }
      if (message.jsonrpc !== JSONRPC_VERSION) {
        failProtocol("DeepSeek Harness JSON-RPC emitted a frame with an unsupported protocol version.");
        return;
      }
      if ("id" in message) {
        const id = message.id;
        if (typeof id !== "string") {
          failProtocol("DeepSeek Harness JSON-RPC response id must be a string.");
          return;
        }
        if (id === initializeId) {
          if (message.error !== undefined) {
            failProtocol("DeepSeek Harness JSON-RPC request failed: " + (extractText(message.error) ?? "unknown JSON-RPC error"));
            return;
          }
          const result = message.result as Record<string, unknown> | undefined;
          const serverInfo = result?.serverInfo as Record<string, unknown> | undefined;
          if (serverInfo?.name !== SERVER_INFO.name || serverInfo?.version !== SERVER_INFO.version || result?.protocolVersion !== JSONRPC_VERSION) {
            failProtocol("DeepSeek Harness JSON-RPC initialization returned an incompatible server identity.");
            return;
          }
          initialized = true;
          sessionProtocol.sendPrompt();
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
        if (sessionProtocol.ownsResponse(id)) {
          sessionProtocol.consumeLine(line, observer);
          maybeShutdown();
          return;
        }
        failProtocol("DeepSeek Harness JSON-RPC returned an unknown response id: " + id);
        return;
      }
      if (typeof message.method !== "string") {
        failProtocol("DeepSeek Harness JSON-RPC emitted a frame without a method or response id.");
        return;
      }
      sessionProtocol.consumeLine(line, observer);
      maybeShutdown();
    },
    isComplete() {
      return !protocolFailed && initialized && sessionProtocol.isTurnComplete() && shutdownCompleted;
    },
    validateCompletion() {
      clearTimeout(shutdownResponseTimer);
      clearTimeout(shutdownExitTimer);
      if (!initialized) failProtocol("DeepSeek Harness JSON-RPC initialization did not complete.", false);
      for (const reason of sessionProtocol.completionMissingReasons()) {
        failProtocol("DeepSeek Harness JSON-RPC " + reason + ".", false);
      }
      if (!shutdownCompleted) failProtocol("DeepSeek Harness JSON-RPC shutdown did not complete.", false);
      for (const diagnostic of sessionProtocol.diagnostics) {
        if (!diagnostics.some((existing) => existing.message === diagnostic.message)) {
          diagnostics.push(diagnostic);
        }
      }
    },
  };

  function maybeShutdown(): void {
    if (!initialized || !sessionProtocol.isTurnComplete() || shutdownSent) return;
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
