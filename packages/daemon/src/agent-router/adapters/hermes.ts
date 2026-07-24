import type {
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessAdapter,
  HarnessDetectionResult,
  HarnessErrorContext,
  HarnessLaunchPlan,
} from "../types.ts";
import { buildCapabilityEnv, buildCapabilityPathDirs } from "../capabilities.ts";
import {
  buildBaseEnv,
  buildRedactions,
  findExecutableOnPath,
  resolveExecutablePath,
  resolveTimeoutMs,
} from "../utils.ts";
import { normalizeAdapterError, runNativeHarness } from "./shared.ts";
import { runVersionCommand } from "./versions.ts";

const HERMES_COMMANDS = ["hermes-agent", "hermes"] as const;

export const hermesAdapter: HarnessAdapter = {
  id: "hermes",
  label: "Hermes Agent",
  detect: detectHermes,
  buildLaunch: buildHermesLaunch,
  run: runHermes,
  normalizeError: (error: unknown, context: HarnessErrorContext) => normalizeAdapterError("hermes", error, context),
};

async function detectHermes(): Promise<HarnessDetectionResult> {
  const executable = await findFirstHermesExecutable();
  if (!executable) {
    return { id: "hermes", label: "Hermes Agent", status: "missing" };
  }

  return {
    id: "hermes",
    label: "Hermes Agent",
    status: "available",
    path: executable,
    version: await detectHermesVersion(executable),
  };
}

async function buildHermesLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  const executable = await resolveHermesExecutable(input.executablePath);
  if (!executable) {
    throw new Error("Hermes Agent CLI was not found on PATH.");
  }

  const args = ["-z", input.prompt];
  if (input.model) {
    args.push("--model", input.model);
  }

  const env = buildBaseEnv(
    executable,
    buildCapabilityEnv(input.env ?? {}, input.runtimeToolCapabilities),
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

async function runHermes(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  return runNativeHarness("hermes", plan, observer, request, {
    emptyMessage: "Hermes Agent returned an empty response.",
    nonZeroMessage: (exitCode) => `Hermes Agent exited with code ${exitCode}.`,
    timeoutMessage: (timeoutMs) => `Hermes Agent timed out after ${timeoutMs}ms.`,
    parseEvents: (stdout) => ({ outputText: stdout.trim() }),
  });
}

async function findFirstHermesExecutable(): Promise<string | null> {
  for (const command of HERMES_COMMANDS) {
    const executable = await findExecutableOnPath(command);
    if (executable) {
      return executable;
    }
  }
  return null;
}

async function resolveHermesExecutable(executablePath: string | undefined): Promise<string | null> {
  if (executablePath?.trim()) {
    return resolveExecutablePath("hermes", executablePath);
  }
  return findFirstHermesExecutable();
}

async function detectHermesVersion(executable: string): Promise<string> {
  const version = await runVersionCommand(executable, ["--version"]);
  if (version) {
    return version;
  }
  return runVersionCommand(executable, ["version"]);
}
