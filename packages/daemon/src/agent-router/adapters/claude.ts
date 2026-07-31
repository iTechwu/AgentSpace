import type {
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessAdapter,
  HarnessDetectionResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import type { ExecController } from "@dofe-agent/sandbox";
import { extractClaudeFallbackText, mapClaudeNativeEvent } from "../events.ts";
import {
  buildCapabilityAllowedTools,
  buildCapabilityEnv,
  buildCapabilityPathDirs,
} from "../capabilities.ts";
import {
  buildBaseEnv,
  buildRedactions,
  createDiagnostic,
  findExecutableOnPath,
  parseJsonObjects,
  resolveExecutablePath,
  resolveTimeoutMs,
  tailText,
} from "../utils.ts";
import { discoverSessionId, emitSessionUpdate, normalizeAdapterError, runNativeHarness } from "./shared.ts";
import { runVersionCommand } from "./versions.ts";

const CLAUDE_ROOT_BASE_ALLOWED_TOOLS = [
  "Bash(command -v *)",
  "Bash(mkdir -p runtime-output/artifacts/sheets)",
  "Bash(mkdir -p runtime-output/artifacts)",
  "Bash(cat runtime-output/artifacts/sheets/*)",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
];

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  label: "Claude Code",
  detect: detectClaude,
  buildLaunch: buildClaudeLaunch,
  run: runClaude,
  normalizeError: (error: unknown, context: HarnessErrorContext) => normalizeAdapterError("claude", error, context),
};

async function detectClaude(): Promise<HarnessDetectionResult> {
  const executable = await findExecutableOnPath("claude");
  if (!executable) {
    return { id: "claude", label: "Claude Code", status: "missing" };
  }

  return {
    id: "claude",
    label: "Claude Code",
    status: "available",
    path: executable,
    version: await runVersionCommand(executable, ["--version"]),
  };
}

async function buildClaudeLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  const executable = await resolveExecutablePath("claude", input.executablePath);
  if (!executable) {
    throw new Error("Claude Code CLI was not found on PATH.");
  }

  const usesRealtimeInput = input.handleControlRequests === true;
  const args = ["-p"];
  // Claude Code treats -p as an option with an immediate argument. Keeping
  // the prompt after other flags leaves --print without any input on 2.1.216.
  if (!usesRealtimeInput) {
    args.push(input.prompt);
  }
  args.push("--output-format", "stream-json", "--verbose");
  if (usesRealtimeInput) {
    args.push("--input-format", "stream-json");
  }
  if (input.maxTurns && input.maxTurns > 0) {
    args.push("--max-turns", String(Math.floor(input.maxTurns)));
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  const permissionMode = input.permissionMode ?? input.mode;
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }
  const allowedTools = dedupeStrings([
    ...(input.allowedTools ?? []),
    ...buildCapabilityAllowedTools(input.runtimeToolCapabilities),
    ...(input.temporaryAllowedTools ?? []),
  ]);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", ...dedupeStrings([
      ...allowedTools,
    ]));
  }
  if (input.claudeTools) {
    args.push("--tools", input.claudeTools);
  }
  const env = buildBaseEnv(
    executable,
    buildCapabilityEnv(sanitizeClaudeEnv(input.env) ?? {}, input.runtimeToolCapabilities),
    buildCapabilityPathDirs(input.runtimeToolCapabilities),
  );
  return {
    executable,
    args,
    cwd: input.cwd,
    env,
    stdin: usesRealtimeInput ? buildClaudeStreamJsonInput(input.prompt) : undefined,
    keepStdinOpen: usesRealtimeInput,
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    redactions: buildRedactions(env),
  };
}

async function runClaude(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  let discoveredSessionId = request.sessionId;
  let stdinController: ExecController | undefined;
  let stdoutBuffer = "";
  let streamedTextEvent = false;
  const processLine = (line: string, runObserver: AgentRouterObserver): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      discoveredSessionId = discoverSessionId([event], discoveredSessionId);
      if (request.handleControlRequests) {
        void buildClaudeControlResponse(event, request, discoveredSessionId).then((controlResponse) => {
          if (controlResponse) {
            stdinController?.writeStdin(`${controlResponse}\n`);
          }
        }).catch((error) => {
          runObserver.emit({
            type: "tool_output",
            tool: "approval",
            output: `Runtime approval failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
      for (const mapped of mapClaudeNativeEvent(event)) {
        if (mapped.type === "text_delta") {
          streamedTextEvent = true;
        }
        runObserver.emit(mapped);
      }
      if (event.type === "result") {
        stdinController?.closeStdin();
      }
    } catch {
      // Parse diagnostics are produced by the final stdout parser.
    }
  };

  return runNativeHarness("claude", plan, observer, request, {
    emptyMessage: "Claude Code returned an empty response.",
    nonZeroMessage: (exitCode) => `Claude Code exited with code ${exitCode}.`,
    timeoutMessage: (timeoutMs) => `claude timed out after ${timeoutMs}ms.`,
    onReady: (controller) => {
      stdinController = controller;
    },
    onStdout: (chunk, runObserver) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line, runObserver);
      }
    },
    parseEvents: (stdout, stderr, runObserver) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer, runObserver);
        stdoutBuffer = "";
      }
      const events = parseJsonObjects(stdout);
      const diagnostics = [];
      let outputText = "";

      if (events.length === 0 && stdout.trim().startsWith("{")) {
        diagnostics.push(createDiagnostic("harness.protocol_parse_failed", "Claude Code stream-json output could not be parsed.", {
          rawProviderMessage: formatClaudeParseDiagnostic(events, stdout),
          stderrTail: tailText(stderr),
        }));
      }
      if (events.length === 0 && stdout.trim() && !stdout.trim().startsWith("{")) {
        diagnostics.push(createDiagnostic("harness.protocol_parse_failed", "Claude Code emitted non-JSON stream output.", {
          severity: "error",
          rawProviderMessage: formatClaudeParseDiagnostic(events, stdout),
          stderrTail: tailText(stderr),
        }));
      }

        for (const event of events) {
          for (const mapped of mapClaudeNativeEvent(event)) {
            if (streamedTextEvent && mapped.type === "text_delta") {
              continue;
            }
            runObserver.emit(mapped);
          }
        diagnostics.push(...buildClaudePermissionDenialDiagnostics(event));
        const text = extractClaudeFallbackText(event);
        if (text) {
          outputText = appendOutputText(outputText, text);
        }
      }

      const resultEvent = events.find((event) => event.type === "result" && typeof event.result === "string");
      if (resultEvent && typeof resultEvent.result === "string") {
        outputText = resultEvent.result.trim();
      }

      const sessionId = discoverSessionId(events, request.sessionId);
      emitSessionUpdate(runObserver, sessionId);
      if (!outputText.trim()) {
        diagnostics.push(createDiagnostic("harness.empty_response", "Claude Code returned an empty response.", {
          rawProviderMessage: formatClaudeParseDiagnostic(events, stdout),
          stderrTail: tailText(stderr),
        }));
      }
      return { outputText, sessionId, diagnostics };
    },
  });
}

function buildClaudeStreamJsonInput(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`;
}

function sanitizeClaudeEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) {
    return undefined;
  }
  const env = { ...extra };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDECODE_") || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

function appendOutputText(current: string, next: string): string {
  return current ? `${current}\n${next}` : next;
}

function formatClaudeParseDiagnostic(events: Array<Record<string, unknown>>, stdout: string): string {
  const eventCounts = new Map<string, number>();
  for (const event of events) {
    const type = typeof event.type === "string" && event.type.trim() ? event.type.trim() : "unknown";
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
  }
  const eventTypes = eventCounts.size === 0
    ? "none"
    : [...eventCounts.entries()].map(([type, count]) => `${type}:${count}`).join(",");
  const stdoutLines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const nonJsonLineCount = stdoutLines.filter((line) => !line.startsWith("{")).length;
  const parseErrorCount = stdoutLines.filter((line) => {
    if (!line.startsWith("{")) {
      return false;
    }
    try {
      JSON.parse(line);
      return false;
    } catch {
      return true;
    }
  }).length;
  const resultEvent = events.some((event) => event.type === "result");
  const textEvent = events.some((event) => Boolean(extractClaudeFallbackText(event)));
  const toolEvent = events.some((event) => event.type === "tool_use" || event.type === "tool_result");
  const parts = [
    `events=${eventTypes}`,
    `resultEvent=${resultEvent}`,
    `textEvent=${textEvent}`,
    `toolEvent=${toolEvent}`,
    `parseErrors=${parseErrorCount}`,
    `nonJsonLines=${nonJsonLineCount}`,
  ];
  const stdoutTail = tailText(stdout);
  if (stdoutTail) {
    parts.push(`stdoutTail=${JSON.stringify(stdoutTail)}`);
  }
  return parts.join("; ");
}

function buildClaudePermissionDenialDiagnostics(event: Record<string, unknown>): ReturnType<typeof createDiagnostic>[] {
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  return denials.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const toolName = typeof record.tool_name === "string" && record.tool_name.trim()
      ? record.tool_name.trim()
      : "unknown";
    const command = record.tool_input && typeof record.tool_input === "object"
      ? (record.tool_input as Record<string, unknown>).command
      : undefined;
    const commandPreview = typeof command === "string" && command.trim()
      ? `: ${command.trim()}`
      : "";
    return [createDiagnostic(
      "harness.tool_permission_denied",
      `Claude Code denied ${toolName}${commandPreview}.`,
      {
        rawProviderMessage: tailText(JSON.stringify(record)),
      },
    )];
  });
}

export function buildDefaultClaudeAllowedTools(): string[] {
  return [...CLAUDE_ROOT_BASE_ALLOWED_TOOLS];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

async function buildClaudeControlResponse(
  event: Record<string, unknown>,
  request: AgentRouterRunRequest,
  sessionId: string | undefined,
): Promise<string | null> {
  if (event.type !== "control_request") {
    return null;
  }

  const requestId = typeof event.request_id === "string" ? event.request_id : "";
  if (!requestId) {
    return null;
  }

  const controlRequest = event.request && typeof event.request === "object"
    ? event.request as Record<string, unknown>
    : {};
  const input = controlRequest.input && typeof controlRequest.input === "object"
    ? controlRequest.input as Record<string, unknown>
    : {};
  if (request.onApprovalRequest) {
    const toolName = typeof controlRequest.tool_name === "string" ? controlRequest.tool_name : "unknown";
    const decision = await request.onApprovalRequest({
      harness: "claude",
      sessionId,
      toolName,
      toolInput: input,
      contentPreview: formatToolApprovalPreview(toolName, input),
    });
    if (decision.decision !== "approved") {
      return JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "deny",
            message: decision.comment ?? "Rejected in DofeAgent.",
          },
        },
      });
    }
  }

  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput: input,
      },
    },
  });
}

function formatToolApprovalPreview(toolName: string, toolInput?: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput?.command === "string") {
    return `Bash: ${toolInput.command}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput ?? {})}`;
}
