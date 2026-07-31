import { resolve } from "node:path";
import type {
  AgentRouterEvent,
  AgentRouterHarness,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
  HarnessCatalogEntry,
  HarnessDetectionResult,
} from "./types.ts";
import { AGENT_ROUTER_HARNESSES } from "./types.ts";
import { getHarnessAdapter, HARNESS_ADAPTERS } from "./adapters/index.ts";
import { runCapabilityDiagnostics } from "./capabilities.ts";
import { createDiagnostic, resolveExecutablePath, buildEnvValueRedactions } from "./utils.ts";

export function listAgentRouterHarnesses(): HarnessCatalogEntry[] {
  return AGENT_ROUTER_HARNESSES.map((id) => ({
    id,
    label: HARNESS_ADAPTERS[id].label,
  }));
}

export async function detectAgentRouterHarnesses(): Promise<{ harnesses: HarnessDetectionResult[] }> {
  const harnesses = await Promise.all(AGENT_ROUTER_HARNESSES.map((id) => HARNESS_ADAPTERS[id].detect()));
  return { harnesses };
}

export async function runAgentRouter(
  request: AgentRouterRunRequest,
  observer: AgentRouterObserver = { emit: () => {} },
): Promise<AgentRouterRunResult> {
  const validationError = validateRunRequest(request);
  if (validationError) {
    const now = new Date().toISOString();
    return {
      status: "failed",
      harness: isAgentRouterHarness(request.harness) ? request.harness : "codex",
      events: [],
      diagnostics: [createDiagnostic("harness.unknown_failure", validationError)],
      startedAt: now,
      finishedAt: now,
    };
  }

  const adapter = getHarnessAdapter(request.harness);
  const events: AgentRouterEvent[] = [];
  const teeObserver: AgentRouterObserver = {
    emit: (event) => {
      events.push(event);
      observer.emit(event);
    },
  };
  const startedAt = new Date().toISOString();

  try {
    const detection = request.executablePath
      ? await detectRequestedExecutable(request.harness, request.executablePath)
      : await adapter.detect();
    if (detection.status === "available") {
      teeObserver.emit({
        type: "harness_detected",
        harness: detection.id,
        path: detection.path,
        version: detection.version,
      });
    }

    if (detection.status !== "available") {
      return {
        status: "failed",
        harness: request.harness,
        events,
        diagnostics: [
          createDiagnostic("harness.cli_missing", `${adapter.label} CLI was not found on PATH.`),
        ],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    const plan = await adapter.buildLaunch({
      ...request,
      cwd: resolve(request.cwd),
    });
    // Also redact Skill-injected values whose key names don't match the secret
    // name pattern (e.g. a credential stored as `MY_SERVICE_CODE`). The adapter
    // already redacts secret-named entries; this closes the name-based gap.
    if (request.skillEnvKeys?.length) {
      plan.redactions = [
        ...(plan.redactions ?? []),
        ...buildEnvValueRedactions(plan.env, request.skillEnvKeys),
      ];
    }
    const capabilityDiagnostics = runCapabilityDiagnostics({
      env: plan.env,
      capabilities: request.runtimeToolCapabilities,
    });
    if (capabilityDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return {
        status: "failed",
        harness: request.harness,
        events,
        diagnostics: capabilityDiagnostics,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    const result = await adapter.run(plan, teeObserver, request);
    return {
      ...result,
      events: mergeEventStreams(events, result.events),
      diagnostics: mergeDiagnostics(capabilityDiagnostics, result.diagnostics),
    };
  } catch (error) {
    return {
      status: "failed",
      harness: request.harness,
      events,
      diagnostics: [adapter.normalizeError(error, { request })],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function detectRequestedExecutable(
  harness: AgentRouterHarness,
  executablePath: string,
): Promise<HarnessDetectionResult> {
  const path = await resolveExecutablePath(harness, executablePath);
  if (!path) {
    return {
      id: harness,
      label: HARNESS_ADAPTERS[harness].label,
      status: "missing",
    };
  }
  return {
    id: harness,
    label: HARNESS_ADAPTERS[harness].label,
    status: "available",
    path,
  };
}

export function isAgentRouterHarness(value: string): value is AgentRouterHarness {
  return AGENT_ROUTER_HARNESSES.includes(value as AgentRouterHarness);
}

function validateRunRequest(request: AgentRouterRunRequest): string | undefined {
  if (request.version !== 1) {
    return "AgentRouter request version must be 1.";
  }
  if (!isAgentRouterHarness(request.harness)) {
    return `Unsupported harness "${request.harness}".`;
  }
  if (!request.prompt.trim()) {
    return "Prompt is required.";
  }
  if (!request.cwd.trim()) {
    return "cwd is required.";
  }
  return undefined;
}

function mergeEventStreams(first: AgentRouterEvent[], second: AgentRouterEvent[]): AgentRouterEvent[] {
  const result: AgentRouterEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...first, ...second]) {
    const key = JSON.stringify(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(event);
  }
  return result;
}

function mergeDiagnostics<T extends { code: string; message: string; rawProviderMessage?: string }>(
  first: T[],
  second: T[],
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const diagnostic of [...first, ...second]) {
    const key = `${diagnostic.code}:${diagnostic.message}:${diagnostic.rawProviderMessage ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
