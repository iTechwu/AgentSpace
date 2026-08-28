import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  createDiagnostic,
  findExecutableOnPath,
  resolveExecutablePath,
  resolveTimeoutMs,
} from "../utils.ts";
import { normalizeAdapterError, runNativeHarness } from "./shared.ts";
import { runVersionCommand } from "./versions.ts";
import { buildDeepSeekJsonRpcLaunch, runDeepSeekJsonRpc } from "./deepseek-jsonrpc.ts";

const SUPPORTED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const SESSION_UNSUPPORTED_MESSAGE = "DeepSeek Harness headless mode does not support session resume.";
const STALE_PATCH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PATCH_FILE_PATTERN = /^\.dofe-deepseek-harness\.patch-[0-9a-f-]+\.yml$/i;
const DISABLED_P0_TOOL_ROWS = [
  "web-search-deepseek",
  "tool-web",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "tool-workflow",
  "tool-ralph",
] as const;

export const deepSeekHarnessAdapter: HarnessAdapter = {
  id: "deepseek-harness",
  label: "DeepSeek Harness",
  detect: detectDeepSeekHarness,
  buildLaunch: buildDeepSeekHarnessLaunch,
  run: runDeepSeekHarness,
  disposeLaunch: disposeDeepSeekLaunch,
  normalizeError: normalizeDeepSeekHarnessError,
};

async function detectDeepSeekHarness(): Promise<HarnessDetectionResult> {
  const executable = await findExecutableOnPath("dsh") ?? await findExecutableOnPath("dsh-jsonrpc-agent");
  if (!executable) {
    return { id: "deepseek-harness", label: "DeepSeek Harness", status: "missing" };
  }
  return {
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    status: "available",
    path: executable,
    version: await runVersionCommand(executable, ["--version"]),
  };
}

async function buildDeepSeekHarnessLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan> {
  if (input.mode === "jsonrpc") {
    if (input.deepSeekJsonRpcEnabled !== true) {
      throw new Error("DeepSeek Harness JSON-RPC protocol spike is disabled by its explicit feature gate.");
    }
    return buildDeepSeekJsonRpcLaunch(input);
  }
  if (input.sessionId?.trim()) {
    throw new Error(SESSION_UNSUPPORTED_MESSAGE);
  }
  const executable = input.executablePath?.trim()
    ? await resolveExecutablePath("deepseek-harness", input.executablePath)
    : await findExecutableOnPath("dsh");
  if (!executable) {
    throw new Error("DeepSeek Harness CLI was not found on PATH.");
  }

  cleanupStalePatchFiles(input.cwd);

  const args = ["--profile", "headless"];
  if (input.model) {
    if (!SUPPORTED_MODELS.has(input.model)) {
      throw new Error(`DeepSeek Harness model "${input.model}" is not supported.`);
    }
  }
  const invocationId = randomUUID();
  const patchPath = join(input.cwd, `.dofe-deepseek-harness.patch-${invocationId}.yml`);
  const patch = input.model
    ? [
      "- id: agent-default-model",
      "  config:",
      "    provider: deepseek-official",
      `    model: ${input.model}`,
    ]
    : [];
  for (const id of DISABLED_P0_TOOL_ROWS) {
    patch.push(`- id: ${id}`, "  disabled: true");
  }
  patch.push("");
  writeFileSync(patchPath, patch.join("\n"), { encoding: "utf8", mode: 0o600 });
  args.push("--patch", patchPath);
  args.push(input.prompt);

  const env = buildBaseEnv(
    executable,
    buildCapabilityEnv(input.env ?? {}, input.runtimeToolCapabilities),
    buildCapabilityPathDirs(input.runtimeToolCapabilities),
  );
  const configuredHome = env.DSH_HOME?.trim();
  const runtimeHomePath = join(
    configuredHome || input.cwd,
    `.dofe-deepseek-harness-${invocationId}`,
  );
  env.DSH_HOME = runtimeHomePath;
  env.DSH_PERMISSION_MODE = "workspace-write";
  env.DSH_TELEMETRY_DISABLED = "1";
  env.DSH_TOOLS_MODE = "";
  mkdirSync(env.DSH_HOME, { recursive: true, mode: 0o700 });

  return {
    executable,
    args,
    cwd: input.cwd,
    env,
    metadata: { modelPatchPath: patchPath, runtimeHomePath },
    timeoutMs: resolveTimeoutMs(input.timeoutMs),
    redactions: buildRedactions(env),
  };
}

function cleanupStalePatchFiles(cwd: string): void {
  const cutoff = Date.now() - STALE_PATCH_MAX_AGE_MS;
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !PATCH_FILE_PATTERN.test(entry.name)) continue;
    const path = join(cwd, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A concurrent task may have already removed or replaced the file.
    }
  }
}

async function runDeepSeekHarness(
  plan: HarnessLaunchPlan,
  observer: AgentRouterObserver,
  request: AgentRouterRunRequest,
): Promise<AgentRouterRunResult> {
  try {
    if (plan.metadata?.executionMode === "jsonrpc") {
      return await runDeepSeekJsonRpc(plan, observer, request);
    }
    return await runNativeHarness("deepseek-harness", plan, observer, request, {
      emptyMessage: "DeepSeek Harness returned an empty response.",
      nonZeroMessage: (exitCode) => `DeepSeek Harness exited with code ${exitCode}.`,
      timeoutMessage: (timeoutMs) => `DeepSeek Harness timed out after ${timeoutMs}ms.`,
      failureDiagnostics: (processResult) => buildDeepSeekHarnessFailureDiagnostics(
        processResult.stdout,
        processResult.stderr,
      ),
      parseEvents: (stdout) => ({ outputText: stdout.trim() }),
    });
  } finally {
    disposeDeepSeekLaunch(plan);
  }
}

function disposeDeepSeekLaunch(plan: HarnessLaunchPlan): void {
  const patchPath = plan.metadata?.modelPatchPath;
  if (patchPath) rmSync(patchPath, { force: true });
  const runtimeHomePath = plan.metadata?.runtimeHomePath;
  if (runtimeHomePath) rmSync(runtimeHomePath, { recursive: true, force: true });
}

function buildDeepSeekHarnessFailureDiagnostics(stdout: string, stderr: string) {
  const rawProviderMessage = `${stderr}\n${stdout}`.trim();
  const normalized = rawProviderMessage.toLowerCase();
  if (/deepseek_api_key.*(?:required|missing|not set|undefined)/i.test(rawProviderMessage)) {
    return [createDiagnostic("harness.auth_required", "DeepSeek API credentials are required.", {
      rawProviderMessage,
      stderrTail: stderr.trim(),
    })];
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key/.test(normalized)) {
    return [createDiagnostic("harness.auth_invalid", "DeepSeek API credentials were rejected.", {
      rawProviderMessage,
      stderrTail: stderr.trim(),
    })];
  }
  if (/model.*(?:not found|unavailable|unsupported)|(?:not found|unavailable|unsupported).*model/.test(normalized)) {
    return [createDiagnostic("harness.model_unavailable", "The selected DeepSeek model is unavailable.", {
      rawProviderMessage,
      stderrTail: stderr.trim(),
    })];
  }
  if (/profile.*(?:missing|not found)|cordis.*(?:invalid|failed)/.test(normalized)) {
    return [createDiagnostic("harness.profile_missing", "DeepSeek Harness headless profile is unavailable or invalid.", {
      rawProviderMessage,
      stderrTail: stderr.trim(),
    })];
  }
  return [];
}

function normalizeDeepSeekHarnessError(error: unknown, context: HarnessErrorContext) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === SESSION_UNSUPPORTED_MESSAGE || message.includes("one-shot JSON-RPC mode does not support")) {
    return createDiagnostic("harness.session_missing", message);
  }
  if (message.includes("model") && message.includes("not supported")) {
    return createDiagnostic("harness.model_unavailable", message);
  }
  if (message.includes("JSON-RPC") && (
    message.includes("Cordis config")
    || message.includes("DSH_CORDIS_CONFIG")
    || message.includes("feature gate")
  )) {
    return createDiagnostic("harness.profile_missing", message);
  }
  if (message.includes("JSON-RPC runtime was not found")) {
    return createDiagnostic("harness.cli_missing", message);
  }
  if (message.includes("JSON-RPC runtime executable") && message.includes("SHA-256")) {
    return createDiagnostic("harness.cli_missing", message);
  }
  return normalizeAdapterError("deepseek-harness", error, context);
}
