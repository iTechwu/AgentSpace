import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentRouterEvent,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessAdapter,
  HarnessDetectionResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import { createCodexEventMapperState, createNarrationDedupEmitter, extractCodexFinalText, mapCodexNativeEvent } from "../events.ts";
import { buildCapabilityEnv, buildCapabilityPathDirs } from "../capabilities.ts";
import {
  buildBaseEnv,
  buildRedactions,
  createDiagnostic,
  findExecutableOnPath,
  resolveExecutablePath,
  resolveTimeoutMs,
  tailText,
} from "../utils.ts";
import { discoverSessionId, emitSessionUpdate, normalizeAdapterError, parseJsonEventOutput, runNativeHarness } from "./shared.ts";
import { runVersionCommand } from "./versions.ts";
import { buildCodexMcpGatewayArgs } from "../mcp-gateway.ts";

const CODEX_OUTPUT_ENV = "AGENT_ROUTER_CODEX_OUTPUT_FILE";

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex CLI",
  detect: detectCodex,
  buildLaunch: buildCodexLaunch,
  run: runCodex,
  normalizeError: (error: unknown, context: HarnessErrorContext) => normalizeAdapterError("codex", error, context),
};

async function detectCodex(): Promise<HarnessDetectionResult> {
  const executable = await findExecutableOnPath("codex");
  if (!executable) {
    return { id: "codex", label: "Codex CLI", status: "missing" };
  }

  return {
    id: "codex",
    label: "Codex CLI",
    status: "available",
    path: executable,
    version: await runVersionCommand(executable, ["--version"]),
  };
}

async function buildCodexLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  const executable = await resolveExecutablePath("codex", input.executablePath);
  if (!executable) {
    throw new Error("Codex CLI was not found on PATH.");
  }

  const outputDir = mkdtempSync(join(tmpdir(), "agent-router-codex-"));
  const outputFile = join(outputDir, "last-message.txt");
  const baseArgs = [
    "--json",
    "--skip-git-repo-check",
    // Blank the user config.toml layer ($CODEX_HOME/config.toml) so pre-existing
    // MCP servers or other ambient settings from the user's machine never leak
    // into a task. Auth still uses CODEX_HOME, so the operator's login state is
    // preserved. Applies to both first run and `exec resume` (shared baseArgs).
    // NOTE: codex has no flag that disables project/cloud config layers; the MCP
    // market eligibility gate for codex stays closed until E2E validates isolation.
    "--ignore-user-config",
    "-o", outputFile,
  ];
  if (input.model) {
    baseArgs.push("--model", input.model);
  }
  if (input.codexApprovalPolicy) {
    baseArgs.push("--config", `approval_policy=${JSON.stringify(input.codexApprovalPolicy)}`);
  }
  if (input.mode && !input.sessionId) {
    baseArgs.push("--sandbox", input.mode);
  }
  if (input.codexFullAccess && !input.sessionId) {
    baseArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }
  // Task-scoped MCP gateway: inject the loopback gateway URL as one
  // streamable-HTTP `mcp_servers` entry via a `--config` override. The URL is
  // the only thing codex learns; secrets stay in the daemon. `--config` is a
  // global flag so it must land in baseArgs (before the `exec` subcommand).
  let mcpRedactions: HarnessLaunchPlan["redactions"] = [];
  if (input.mcpGatewayUrl) {
    const injection = buildCodexMcpGatewayArgs(input.mcpGatewayUrl);
    baseArgs.push(...injection.args);
    mcpRedactions = injection.redactions;
  }
  const args = input.sessionId
    ? ["exec", "resume", ...baseArgs, input.sessionId, input.prompt]
    : ["exec", ...baseArgs, input.prompt];
  const env = buildBaseEnv(
    executable,
    buildCapabilityEnv({ ...input.env, [CODEX_OUTPUT_ENV]: outputFile }, input.runtimeToolCapabilities),
    buildCapabilityPathDirs(input.runtimeToolCapabilities),
  );
  return {
    executable,
    args,
    cwd: input.cwd,
    env,
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    redactions: [...buildRedactions(env), ...mcpRedactions],
  };
}

async function runCodex(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  let discoveredSessionId = request.sessionId;
  let stdoutBuffer = "";
  let emitDownstream: (event: AgentRouterEvent) => void = (event) => observer.emit(event);
  const narrationEmitter = createNarrationDedupEmitter((event) => emitDownstream(event));
  const mapperState = createCodexEventMapperState();
  const processLine = (line: string, runObserver: AgentRouterObserver): void => {
    emitDownstream = (event) => runObserver.emit(event);
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      discoveredSessionId = discoverSessionId([event], discoveredSessionId);
      for (const mapped of mapCodexNativeEvent(event, mapperState)) {
        narrationEmitter.emit(mapped);
      }
    } catch {
      // Final parsing reports malformed JSON diagnostics.
    }
  };

  try {
    return await runNativeHarness("codex", plan, observer, request, {
      emptyMessage: "Codex CLI returned an empty final message.",
      nonZeroMessage: (exitCode) => `Codex CLI exited with code ${exitCode}.`,
      timeoutMessage: (timeoutMs) => `Codex CLI timed out after ${timeoutMs}ms.`,
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
        const parsed = parseJsonEventOutput(stdout);
        const diagnostics = [...parsed.diagnostics];
        let outputText = readCodexOutputFile(plan.env[CODEX_OUTPUT_ENV]);

        for (const event of parsed.events) {
          const finalText = extractCodexFinalText(event);
          if (finalText) {
            outputText = finalText;
          }
        }

        if (!outputText && parsed.events.length === 0 && stdout.trim() && !stdout.trim().startsWith("{")) {
          outputText = stdout.trim();
        }
        if (parsed.diagnostics.length > 0) {
          diagnostics.push(createDiagnostic("harness.protocol_parse_failed", "Codex JSON event output could not be fully parsed.", {
            stderrTail: tailText(stderr),
          }));
        }

        const sessionId = discoverSessionId(parsed.events, discoveredSessionId);
        narrationEmitter.flush();
        emitSessionUpdate(runObserver, sessionId);
        return { outputText, sessionId, diagnostics };
      },
    });
  } finally {
    cleanupCodexOutputFile(plan.env[CODEX_OUTPUT_ENV]);
  }
}

function readCodexOutputFile(outputFile: string | undefined): string {
  if (!outputFile) {
    return "";
  }
  try {
    return readFileSync(outputFile, "utf8").trim();
  } catch {
    return "";
  }
}

function cleanupCodexOutputFile(outputFile: string | undefined): void {
  if (!outputFile) {
    return;
  }
  rmSync(dirname(outputFile), { recursive: true, force: true });
}
