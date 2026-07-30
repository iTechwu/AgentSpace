import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessAdapter,
  HarnessDetectionResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import { extractCodexFinalText, mapCodexNativeEvent } from "../events.ts";
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
    "-o", outputFile,
  ];
  if (input.model) {
    baseArgs.push("--model", input.model);
  }
  if (input.mode && !input.sessionId) {
    baseArgs.push("--sandbox", input.mode);
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
    redactions: buildRedactions(env),
  };
}

async function runCodex(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  try {
    return await runNativeHarness("codex", plan, observer, request, {
      emptyMessage: "Codex CLI returned an empty final message.",
      nonZeroMessage: (exitCode) => `Codex CLI exited with code ${exitCode}.`,
      timeoutMessage: (timeoutMs) => `Codex CLI timed out after ${timeoutMs}ms.`,
      parseEvents: (stdout, stderr, runObserver) => {
        const parsed = parseJsonEventOutput(stdout);
        const diagnostics = [...parsed.diagnostics];
        let outputText = readCodexOutputFile(plan.env[CODEX_OUTPUT_ENV]);

        for (const event of parsed.events) {
          for (const mapped of mapCodexNativeEvent(event)) {
            runObserver.emit(mapped);
          }
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

        const sessionId = discoverSessionId(parsed.events, request.sessionId);
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
