import type {
  AgentRouterDiagnostic,
  AgentRouterEvent,
  AgentRouterHarness,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import type { ExecController } from "@dofe-agent/sandbox";
import { runLaunchPlan, type SubprocessRunResult } from "../subprocess.ts";
import {
  createDiagnostic,
  extractSessionId,
  outputHasInvalidJsonCandidate,
  parseJsonObjects,
  tailText,
} from "../utils.ts";

export interface NativeRunOptions {
  parseEvents: (stdout: string, stderr: string, observer: AgentRouterObserver) => ParsedHarnessOutput;
  failureDiagnostics?: (
    processResult: SubprocessRunResult,
    parsed: ParsedHarnessOutput,
  ) => AgentRouterDiagnostic[];
  emptyMessage: string;
  nonZeroMessage: (exitCode: number | null) => string;
  timeoutMessage: (timeoutMs: number) => string;
  onReady?: (controller: ExecController, observer: AgentRouterObserver) => void;
  onStdout?: (chunk: string, observer: AgentRouterObserver) => void;
  onStderr?: (chunk: string, observer: AgentRouterObserver) => void;
}

export interface ParsedHarnessOutput {
  outputText?: string;
  sessionId?: string;
  diagnostics?: AgentRouterDiagnostic[];
}

export async function runNativeHarness(
  harness: AgentRouterHarness,
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
  options: NativeRunOptions,
): Promise<AgentRouterRunResult> {
  const startedAt = new Date().toISOString();
  const events: AgentRouterEvent[] = [];
  const teeObserver: AgentRouterObserver = {
    emit: (event) => {
      events.push(event);
      observer.emit(event);
    },
  };
  let processResult: SubprocessRunResult;

  try {
    processResult = await runLaunchPlan(harness, plan, {
      observer: teeObserver,
      onReady: options.onReady ? (controller) => options.onReady?.(controller, teeObserver) : undefined,
      onStdout: options.onStdout ? (chunk) => options.onStdout?.(chunk, teeObserver) : undefined,
      onStderr: options.onStderr ? (chunk) => options.onStderr?.(chunk, teeObserver) : undefined,
      signal: request.signal,
    });
  } catch (error) {
    const diagnostic = createDiagnostic("harness.unknown_failure", error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      harness,
      events,
      diagnostics: [diagnostic],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const stderrTail = tailText(processResult.stderr);
  if (processResult.aborted) {
    return {
      status: "cancelled",
      harness,
      events,
      diagnostics: [],
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  if (processResult.timedOut) {
    return {
      status: "timeout",
      harness,
      events,
      diagnostics: [
        createDiagnostic("harness.timeout", options.timeoutMessage(plan.timeoutMs), { stderrTail }),
      ],
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const parsed = options.parseEvents(processResult.stdout, processResult.stderr, teeObserver);
  const diagnostics = [...(parsed.diagnostics ?? [])];

  if (processResult.exitCode !== 0) {
    diagnostics.push(...(options.failureDiagnostics?.(processResult, parsed) ?? []));
    diagnostics.push(createDiagnostic("harness.exited_nonzero", options.nonZeroMessage(processResult.exitCode), {
      rawProviderMessage: tailText(`${processResult.stderr}\n${processResult.stdout}`),
      stderrTail,
    }));
    return {
      status: "failed",
      harness,
      sessionId: parsed.sessionId,
      outputText: parsed.outputText,
      events,
      diagnostics: dedupeDiagnostics(diagnostics),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  if (!parsed.outputText?.trim()) {
    diagnostics.push(createDiagnostic("harness.empty_response", options.emptyMessage, { stderrTail }));
    return {
      status: "failed",
      harness,
      sessionId: parsed.sessionId,
      events,
      diagnostics: dedupeDiagnostics(diagnostics),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  return {
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "failed" : "completed",
    harness,
    sessionId: parsed.sessionId,
    outputText: parsed.outputText.trim(),
    events,
    diagnostics: dedupeDiagnostics(diagnostics),
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function normalizeAdapterError(
  harness: AgentRouterHarness,
  error: unknown,
  context: HarnessErrorContext,
): AgentRouterDiagnostic {
  if (context.timedOut) {
    return createDiagnostic("harness.timeout", `${harness} timed out.`, { stderrTail: context.stderrTail });
  }

  const message = error instanceof Error ? error.message : String(error);
  return createDiagnostic("harness.unknown_failure", message, { stderrTail: context.stderrTail });
}

export function parseJsonEventOutput(output: string): {
  events: Array<Record<string, unknown>>;
  diagnostics: AgentRouterDiagnostic[];
} {
  const events = parseJsonObjects(output);
  const diagnostics: AgentRouterDiagnostic[] = [];
  if (events.length === 0 && outputHasInvalidJsonCandidate(output)) {
    diagnostics.push(createDiagnostic("harness.protocol_parse_failed", "Harness output contained invalid JSON events."));
  }
  return { events, diagnostics };
}

export function discoverSessionId(events: Array<Record<string, unknown>>, initial?: string): string | undefined {
  let sessionId = initial;
  for (const event of events) {
    sessionId = extractSessionId(event) ?? sessionId;
  }
  return sessionId;
}

export function emitSessionUpdate(observer: AgentRouterObserver, sessionId: string | undefined): void {
  if (sessionId) {
    observer.emit({ type: "session_updated", sessionId });
  }
}

function dedupeDiagnostics(diagnostics: AgentRouterDiagnostic[]): AgentRouterDiagnostic[] {
  const seen = new Set<string>();
  const result: AgentRouterDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.message}:${diagnostic.rawProviderMessage ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
