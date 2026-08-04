import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  buildOpenClawProviderHealthSnapshot,
  inspectOpenClawDaemonAuthHealth,
  normalizeOpenClawProviderError,
  type OpenClawDaemonAuthHealth,
  type OpenClawProviderError,
} from "../../openclaw-health.ts";
import type {
  AgentRouterDiagnostic,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessAdapter,
  HarnessDetectionResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import { mapOpenClawNativeEvent } from "../events.ts";
import { buildCapabilityEnv, buildCapabilityPathDirs } from "../capabilities.ts";
import {
  buildBaseEnv,
  buildRedactions,
  createDiagnostic,
  extractText,
  findExecutableOnPath,
  resolveExecutablePath,
  resolveTimeoutMs,
  tailText,
} from "../utils.ts";
import { discoverSessionId, emitSessionUpdate, normalizeAdapterError, parseJsonEventOutput, runNativeHarness } from "./shared.ts";
import { runLaunchPlan } from "../subprocess.ts";
import { runVersionCommand } from "./versions.ts";

export const openClawAdapter: HarnessAdapter = {
  id: "openclaw",
  label: "OpenClaw",
  detect: detectOpenClaw,
  buildLaunch: buildOpenClawLaunch,
  run: runOpenClaw,
  normalizeError: (error: unknown, context: HarnessErrorContext) => normalizeAdapterError("openclaw", error, context),
};

async function detectOpenClaw(): Promise<HarnessDetectionResult> {
  const executable = await findExecutableOnPath("openclaw");
  if (!executable) {
    return { id: "openclaw", label: "OpenClaw", status: "missing" };
  }

  return {
    id: "openclaw",
    label: "OpenClaw",
    status: "available",
    path: executable,
    version: await runVersionCommand(executable, ["--version"]),
  };
}

async function buildOpenClawLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  const executable = await resolveExecutablePath("openclaw", input.executablePath);
  if (!executable) {
    throw new Error("OpenClaw CLI was not found on PATH.");
  }

  const contract = resolveOpenClawContract(input);
  const env = buildBaseEnv(
    executable,
    buildCapabilityEnv(contract.env, input.runtimeToolCapabilities),
    buildCapabilityPathDirs(input.runtimeToolCapabilities),
  );
  const health = inspectOpenClawDaemonAuthHealth({
    workDir: input.cwd,
    env,
    profile: contract.profile,
    model: contract.model,
    requireTaskFiles: isDaemonTaskOpenClawRun(input, env) ? true : false,
  });
  const args = buildOpenClawGlobalArgs(contract);
  const agentName = input.openClawEphemeralAgent && !input.sessionId
    ? `dofe-agent-${randomUUID().slice(0, 8)}`
    : undefined;
  args.push("agent", "--local");
  if (agentName) {
    args.push("--agent", agentName);
  }
  args.push("--message", input.prompt, "--json");
  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  if (input.mode && isOpenClawThinkingMode(input.mode)) {
    args.push("--thinking", input.mode);
  }

  return {
    executable,
    args,
    cwd: input.cwd,
    env,
    metadata: buildOpenClawPlanMetadata(health, contract, agentName),
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    redactions: buildRedactions(env),
  };
}

async function runOpenClaw(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  const preflightDiagnostics = readOpenClawPreflightDiagnostics(plan);
  const brokenPreflight = preflightDiagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (brokenPreflight) {
    const now = new Date().toISOString();
    return {
      status: "failed",
      harness: "openclaw",
      events: [],
      diagnostics: [brokenPreflight],
      startedAt: now,
      finishedAt: now,
    };
  }

  try {
    const setupResult = await setupEphemeralAgent(plan, observer, request.signal);
    if (setupResult) {
      return withPreflightDiagnostics(setupResult, preflightDiagnostics);
    }

    const result = await runNativeHarness("openclaw", plan, observer, request, {
      emptyMessage: "OpenClaw returned an empty response.",
      nonZeroMessage: (exitCode) => `OpenClaw exited with code ${exitCode}.`,
      timeoutMessage: (timeoutMs) => `OpenClaw timed out after ${timeoutMs}ms.`,
      failureDiagnostics: (processResult) => buildOpenClawFailureDiagnostics(
        "run",
        processResult.stderr,
        processResult.stdout,
        processResult.exitCode,
      ),
      parseEvents: (stdout, _stderr, runObserver) => {
        const parsed = parseJsonEventOutput(stdout);
        const diagnostics = [...parsed.diagnostics];
        let outputText = "";

        for (const event of parsed.events) {
          for (const mapped of mapOpenClawNativeEvent(event)) {
            runObserver.emit(mapped);
          }
          const text = extractText(event);
          if (text) {
            outputText = text;
          }
        }

        if (!outputText && parsed.events.length === 0 && stdout.trim() && !stdout.trim().startsWith("{")) {
          outputText = stdout.trim();
        }
        if (parsed.events.length === 0 && stdout.trim()) {
          diagnostics.push(createDiagnostic(
            "harness.protocol_parse_failed",
            "OpenClaw stdout did not contain JSON events; using plain text fallback.",
            {
              severity: "warning",
              rawProviderMessage: tailText(stdout),
            },
          ));
        }
        diagnostics.push(...buildOpenClawEventDiagnostics(parsed.events));

        const sessionId = discoverSessionId(parsed.events, request.sessionId);
        emitSessionUpdate(runObserver, sessionId);
        return { outputText, sessionId, diagnostics };
      },
    });
    return withPreflightDiagnostics(result, preflightDiagnostics);
  } finally {
    cleanupEphemeralAgent(plan, observer);
  }
}

function buildOpenClawGlobalArgs(contract: OpenClawLaunchContract): string[] {
  return contract.profile ? ["--profile", contract.profile] : [];
}

function resolveOpenClawContract(input: AgentRouterRunRequest): OpenClawLaunchContract {
  const env = { ...(input.env ?? {}) };
  const profile = env.DOFE_AGENT_OPENCLAW_PROFILE_OVERRIDE?.trim()
    || env.OPENCLAW_PROFILE?.trim()
    || process.env.OPENCLAW_PROFILE?.trim()
    || undefined;
  const model = env.DOFE_AGENT_OPENCLAW_MODEL_OVERRIDE?.trim()
    || input.model?.trim()
    || env.OPENCLAW_MODEL?.trim()
    || process.env.OPENCLAW_MODEL?.trim()
    || undefined;

  delete env.DOFE_AGENT_OPENCLAW_PROFILE_OVERRIDE;
  delete env.DOFE_AGENT_OPENCLAW_MODEL_OVERRIDE;

  if (profile) {
    env.OPENCLAW_PROFILE = profile;
  }
  if (model) {
    env.OPENCLAW_MODEL = model;
  }
  return { profile, model, env };
}

function isOpenClawThinkingMode(mode: string): boolean {
  return ["off", "minimal", "low", "medium", "high"].includes(mode);
}

function cleanupEphemeralAgent(plan: HarnessLaunchPlan, observer: AgentRouterObserver): void {
  const agentName = plan.metadata?.openClawEphemeralAgentName;
  if (!agentName) {
    return;
  }
  const args = [...extractOpenClawGlobalArgs(plan.args), "agents", "delete", agentName, "--force", "--json"];
  const result = spawnSync(plan.executable, args, {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    observer.emit({
      type: "tool_output",
      tool: "openclaw_cleanup",
      output: `openclaw cleanup warning: ${result.error?.message ?? result.stderr?.trim() ?? "failed to delete temporary agent"}`,
    });
  }
}

async function setupEphemeralAgent(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  signal?: AbortSignal,
): Promise<AgentRouterRunResult | undefined> {
  const agentName = plan.metadata?.openClawEphemeralAgentName;
  if (!agentName) {
    return undefined;
  }
  const startedAt = new Date().toISOString();
  const setupPlan: HarnessLaunchPlan = {
    ...plan,
    args: [...extractOpenClawGlobalArgs(plan.args), "agents", "add", agentName, "--workspace", plan.cwd, "--non-interactive", "--json"],
    stdin: undefined,
    keepStdinOpen: false,
  };
  const result = await runLaunchPlan("openclaw", setupPlan, { observer, signal });
  if (result.aborted) {
    return {
      status: "cancelled",
      harness: "openclaw",
      events: [],
      diagnostics: [],
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  if (result.timedOut) {
    return {
      status: "timeout",
      harness: "openclaw",
      events: [],
      diagnostics: [
        createDiagnostic("harness.timeout", `OpenClaw setup timed out after ${plan.timeoutMs}ms.`, {
          stderrTail: tailText(result.stderr),
        }),
      ],
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  if (result.exitCode !== 0) {
    const diagnostics = buildOpenClawFailureDiagnostics("setup", result.stderr, result.stdout, result.exitCode);
    return {
      status: "failed",
      harness: "openclaw",
      events: [],
      diagnostics,
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  return undefined;
}

function extractOpenClawGlobalArgs(args: string[]): string[] {
  if (args[0] === "--profile" && args[1]) {
    return ["--profile", args[1]];
  }
  return [];
}

interface OpenClawLaunchContract {
  profile?: string;
  model?: string;
  env: Record<string, string>;
}

function buildOpenClawPlanMetadata(
  health: OpenClawDaemonAuthHealth,
  contract: OpenClawLaunchContract,
  agentName: string | undefined,
): Record<string, string> {
  const snapshot = buildOpenClawProviderHealthSnapshot(health);
  return {
    ...(agentName ? { openClawEphemeralAgentName: agentName } : {}),
    openClawProviderHealth: JSON.stringify(snapshot),
    openClawProviderHealthStatus: snapshot.status,
    openClawProviderHealthReason: snapshot.reason ?? "",
    openClawProfile: contract.profile ?? "",
    openClawModel: contract.model ?? "",
  };
}

function readOpenClawPreflightDiagnostics(plan: HarnessLaunchPlan): AgentRouterDiagnostic[] {
  const raw = plan.metadata?.openClawProviderHealth;
  if (!raw) {
    return [];
  }
  try {
    const health = JSON.parse(raw) as {
      status?: string;
      reason?: string;
      error?: {
        code?: string;
        message?: string;
        rawProviderMessage?: string;
      };
    };
    if (health.status === "healthy" || health.status === "unknown") {
      return [];
    }

    const diagnostic = createDiagnostic(
      mapOpenClawProviderErrorCodeToHarnessCode(health.error?.code),
      health.reason || health.error?.message || "OpenClaw provider preflight did not pass.",
      {
        severity: health.status === "broken" ? "error" : "warning",
        rawProviderMessage: health.error?.rawProviderMessage,
      },
    );
    return [diagnostic];
  } catch {
    return [];
  }
}

function withPreflightDiagnostics(
  result: AgentRouterRunResult,
  diagnostics: AgentRouterDiagnostic[],
): AgentRouterRunResult {
  if (diagnostics.length === 0) {
    return result;
  }
  return {
    ...result,
    diagnostics: dedupeOpenClawDiagnostics([...diagnostics, ...result.diagnostics]),
  };
}

function buildOpenClawFailureDiagnostics(
  phase: "setup" | "run",
  stderr: string,
  stdout: string,
  exitCode: number | null,
): AgentRouterDiagnostic[] {
  const raw = tailText(`${stderr}\n${stdout}`) ?? "";
  const providerError = normalizeOpenClawProviderError(raw);
  const stderrTail = tailText(stderr);
  if (providerError) {
    const diagnostic = createDiagnostic(
      mapOpenClawProviderErrorCodeToHarnessCode(providerError.code),
      providerError.message,
      {
        rawProviderMessage: providerError.rawProviderMessage,
        stderrTail,
      },
    );
    return [diagnostic];
  }

  return [
    createDiagnostic("harness.exited_nonzero", `OpenClaw ${phase} exited with code ${exitCode}.`, {
      rawProviderMessage: raw,
      stderrTail,
    }),
  ];
}

function buildOpenClawEventDiagnostics(events: Array<Record<string, unknown>>): AgentRouterDiagnostic[] {
  const diagnostics: AgentRouterDiagnostic[] = [];
  for (const event of events) {
    const rawError = extractOpenClawEventError(event);
    if (!rawError) {
      continue;
    }
    const providerError = normalizeOpenClawProviderError(rawError);
    if (!providerError) {
      continue;
    }
    diagnostics.push(createDiagnostic(
      mapOpenClawProviderErrorCodeToHarnessCode(providerError.code),
      providerError.message,
      {
        rawProviderMessage: providerError.rawProviderMessage,
      },
    ));
  }
  return dedupeOpenClawDiagnostics(diagnostics);
}

function extractOpenClawEventError(event: Record<string, unknown>): string | undefined {
  for (const key of ["error", "errors", "message", "stderr", "diagnostic"]) {
    const value = event[key];
    const text = typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").join("\n")
        : undefined;
    if (text && /error|unauthorized|auth|profile|model|session|conversation|agent|tool|permission|json|protocol/i.test(text)) {
      return text;
    }
  }
  return undefined;
}

function mapOpenClawProviderErrorCodeToHarnessCode(
  code: OpenClawProviderError["code"] | string | undefined,
): AgentRouterDiagnostic["code"] {
  if (code === "provider.cli_missing") return "harness.cli_missing";
  if (code === "provider.auth_invalid") return "harness.auth_invalid";
  if (code === "provider.profile_missing") return "harness.profile_missing";
  if (code === "provider.model_unavailable") return "harness.model_unavailable";
  if (code === "provider.session_invalid") return "harness.session_missing";
  if (code === "provider.tool_missing") return "harness.tool_missing";
  if (code === "provider.tool_unauthorized") return "harness.tool_unauthorized";
  if (code === "provider.tool_permission_denied") return "harness.tool_permission_denied";
  if (code === "provider.empty_response") return "harness.empty_response";
  if (code === "provider.protocol_parse_failed") return "harness.protocol_parse_failed";
  if (code === "provider.timeout") return "harness.timeout";
  return "harness.exited_nonzero";
}

function isDaemonTaskOpenClawRun(input: AgentRouterRunRequest, env: Record<string, string>): boolean {
  if (!input.openClawEphemeralAgent) {
    return false;
  }
  return Boolean(env.DOFE_AGENT_CONTEXT_TASK_ID?.trim());
}

function dedupeOpenClawDiagnostics(diagnostics: AgentRouterDiagnostic[]): AgentRouterDiagnostic[] {
  const result: AgentRouterDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.message}:${diagnostic.rawProviderMessage ?? ""}:${diagnostic.stderrTail ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
