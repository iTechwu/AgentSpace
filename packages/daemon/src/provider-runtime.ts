import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { arch, platform, version as nodeVersion } from "node:process";
import type { DaemonProvider, EmployeeExecutionPolicy, ProviderErrorCategory, ProviderErrorCode, ProviderHealthSnapshot, RuntimeAppContextEntry, RuntimeToolCapability } from "@dofe-agent/domain";
import { formatDaemonProviderLabel, isDaemonProvider } from "@dofe-agent/domain";
import { connectSandbox, resolveSandboxTaskTimeoutMs } from "@dofe-agent/sandbox";
import { buildFeishuLarkCliDiagnosticRuntimeToolCapability } from "@dofe-agent/services";
import {
  buildDefaultClaudeAllowedTools,
  runAgentRouter,
  type AgentRouterDiagnostic,
  type AgentRouterEvent,
  type AgentRouterHarness,
} from "./agent-router/index.ts";
import { buildEnvValueRedactions, buildRedactions, isDaemonOnlyProviderEnvironmentKey, redactText } from "./agent-router/utils.ts";
import { clearTaskOutputArtifacts } from "./bundle.ts";
import { buildOpenClawProviderHealthSnapshot, inspectOpenClawDaemonAuthHealth } from "./openclaw-health.ts";
import { readCliHubReadiness, resolveRuntimeAppUserBinDir } from "./runtime-apps.ts";

export interface ProviderRuntimeRecord {
  id: string;
  workspaceId: string;
  provider: DaemonProvider;
  name: string;
  version?: string;
  status: "online" | "offline";
  deviceInfo?: string;
  metadata: {
    executablePath: string;
    mode: "local" | "remote";
    managedCredentialId?: string;
    provisioningState?: string;
    providerHealth?: Record<string, unknown>;
    providerVerificationRequestedAt?: string;
    openClawProfile?: string;
    openClawModel?: string;
  };
}

export type RemoteRuntimeRecord = ProviderRuntimeRecord;

export interface DetectedProvider {
  provider: DaemonProvider;
  label: string;
  executablePath: string;
  version: string;
}

export interface ProviderTaskEvent {
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
  /** Correlates a tool_result with its tool_use (provider-side call id). */
  refId?: string;
}

export interface ProviderApprovalRequest {
  provider: DaemonProvider;
  runtimeId: string;
  sessionId?: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  contentPreview: string;
}

export interface ProviderApprovalDecision {
  decision: "approved" | "rejected";
  comment?: string;
}

export interface ProviderTaskOptions {
  sessionId?: string;
  /** Explicit task-scoped model selection; never mutate process.env for this. */
  modelId?: string;
  executionPolicy?: EmployeeExecutionPolicy;
  contextEnv?: Record<string, string>;
  /** Keys in `contextEnv` that were injected from per-employee Skill configuration; their values are always redacted from logs. */
  skillEnvKeys?: string[];
  taskTimeoutMs?: number;
  onEvent?: (event: ProviderTaskEvent) => void;
  onApprovalRequest?: (request: ProviderApprovalRequest) => Promise<ProviderApprovalDecision>;
  temporaryAllowedTools?: string[];
  runtimeApps?: RuntimeAppContextEntry[];
  /** Host path corresponding to the managed Runtime's mounted HOME/.local/bin. */
  runtimeAppBinDir?: string;
  /** Whether CLI-Hub apps are reachable from the daemon process for preflight diagnostics. */
  runtimeAppHostDiagnostics?: boolean;
  runtimeToolCapabilities?: RuntimeToolCapability[];
  /** Loopback MCP gateway URL for a task-scoped session; passed to the provider as a one-shot MCP config. */
  mcpGatewayUrl?: string;
  /** Enables the unverified Codex MCP injection path only for an explicit experiment. */
  codexMcpInjectionEnabled?: boolean;
  /** Cancels the active Provider subprocess when the control plane stops the task. */
  signal?: AbortSignal;
}

type ProviderTaskFailureCategory = ProviderErrorCategory | "auth" | "profile" | "model";

export interface ProviderTaskStructuredError {
  provider: DaemonProvider;
  code: ProviderErrorCode;
  category?: ProviderTaskFailureCategory;
  message: string;
  rawProviderMessage?: string;
}

class ProviderTaskExecutionError extends Error {
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly providerError?: ProviderTaskStructuredError;

  constructor(
    message: string,
    metadata?: { sessionId?: string; workDir?: string; providerError?: ProviderTaskStructuredError },
  ) {
    super(message);
    this.name = "ProviderTaskExecutionError";
    this.sessionId = metadata?.sessionId;
    this.workDir = metadata?.workDir;
    this.providerError = metadata?.providerError;
  }
}

const PROVIDER_CATALOG: Array<{
  provider: DaemonProvider;
  label: string;
  command?: string;
  commands?: string[];
  defaultModelId?: string;
  versionArgs?: string[][];
}> = [
  { provider: "codex", label: formatDaemonProviderLabel("codex"), command: "codex" },
  {
    provider: "claude",
    label: formatDaemonProviderLabel("claude"),
    command: "claude",
    defaultModelId: "claude-haiku-4-5-20251001",
  },
  {
    provider: "antigravity",
    label: formatDaemonProviderLabel("antigravity"),
    commands: ["agy", "antigravity"],
    versionArgs: [["--version"], ["version"]],
  },
  {
    provider: "gemini",
    label: formatDaemonProviderLabel("gemini"),
    command: "gemini",
    defaultModelId: "gemini-2.0-flash-lite",
  },
  {
    provider: "opencode",
    label: formatDaemonProviderLabel("opencode"),
    command: "opencode",
    defaultModelId: "opencode-default",
  },
  {
    provider: "openclaw",
    label: formatDaemonProviderLabel("openclaw"),
    command: "openclaw",
  },
  {
    provider: "nanobot",
    label: formatDaemonProviderLabel("nanobot"),
    command: "nanobot",
    defaultModelId: "nanobot-default",
  },
  {
    provider: "hermes",
    label: formatDaemonProviderLabel("hermes"),
    commands: ["hermes-agent", "hermes"],
    versionArgs: [["--version"], ["version"]],
  },
];

const CLAUDE_MISSING_RESUME_SESSION_PATTERN = /No conversation found with session ID:/i;
const CLAUDE_POISONED_RESUME_SESSION_PATTERN = /prompt injection detected[\s\S]*encoding_bypass|encoding_bypass[\s\S]*prompt injection detected/i;
const CODEX_MISSING_RESUME_SESSION_PATTERN = /no rollout found for thread id\s+([^\s)]+)/i;
const CODEX_STALLED_RESUME_PATTERN = /falling back from websockets to https transport[\s\S]*request timed out/i;
const OPENCLAW_MISSING_RESUME_SESSION_PATTERN = /session .*not found|session.*missing|conversation .*not found|conversation.*missing|agent .*not found|agent.*missing|unknown session/i;

export function detectProviders(): DetectedProvider[] {
  const allowedProviders = readProviderAllowlist();
  return PROVIDER_CATALOG
    .filter((candidate) => !allowedProviders || allowedProviders.has(candidate.provider))
    .map((candidate) => {
      const executablePath = findFirstExecutableOnPath(resolveProviderCommands(candidate));
      if (!executablePath) {
        return null;
      }
      if (candidate.provider === "claude") {
        warnClaudeRootRuntimeIfNeeded("detected");
      }

      return {
        provider: candidate.provider,
        label: candidate.label,
        executablePath,
        version: detectProviderVersion(executablePath, candidate.versionArgs),
      } satisfies DetectedProvider;
    })
    .filter((value): value is DetectedProvider => value !== null);
}

function readProviderAllowlist(): Set<DaemonProvider> | undefined {
  const configured = process.env.DOFE_AGENT_RUNTIME_PROVIDER?.trim();
  if (!configured) {
    return undefined;
  }

  const providers = configured
    .split(",")
    .map((provider) => provider.trim())
    .filter(isDaemonProvider);
  return new Set(providers);
}

export async function runProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  options: ProviderTaskOptions = {},
): Promise<{ output: string; sessionId?: string }> {
  const taskTimeoutMs = resolveSandboxTaskTimeoutMs(options.taskTimeoutMs);
  if (runtime.provider === "claude") {
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "gemini") {
    return runGeminiProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "antigravity") {
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "opencode") {
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "openclaw") {
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "hermes") {
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider === "nanobot") {
    return runNanoBotProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
  }
  if (runtime.provider !== "codex") {
    throw new Error(`Provider "${runtime.provider}" is not supported.`);
  }

  return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, options);
}

async function runAgentRouterProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  taskTimeoutMs: number,
  options: ProviderTaskOptions,
): Promise<{ output: string; sessionId?: string }> {
  clearTaskOutputArtifacts(workDir);
  const harness = runtime.provider as AgentRouterHarness;
  const runtimeToolCapabilities = buildRuntimeToolCapabilities(options);
  const contextEnv = buildAgentRouterProviderEnv(runtime, options.contextEnv);
  const sessionId = resolveAgentRouterSessionId(runtime, options.sessionId);
  const result = await runAgentRouter({
    version: 1,
    harness,
    prompt,
    cwd: workDir,
    executablePath: runtime.metadata.executablePath,
    model: options.modelId ?? resolveModelId(runtime),
    mode: runtime.provider === "codex"
      ? resolveCodexLaunchMode(runtime, options.executionPolicy?.codexSandboxMode)
      : resolveAgentRouterMode(runtime),
    sessionId,
    env: contextEnv,
    skillEnvKeys: options.skillEnvKeys,
    providerHealth: runtime.provider === "openclaw"
      ? readRuntimeProviderHealthMetadata(runtime)
      : undefined,
    timeoutMs: taskTimeoutMs,
    maxTurns: runtime.provider === "claude" ? 30 : undefined,
    permissionMode: runtime.provider === "claude"
      ? options.executionPolicy?.claudePermissionMode ?? resolveClaudePermissionMode()
      : undefined,
    codexApprovalPolicy: runtime.provider === "codex" ? options.executionPolicy?.codexApprovalPolicy : undefined,
    codexFullAccess: runtime.provider === "codex" && shouldUseCodexFullAccess(runtime, options.executionPolicy?.codexSandboxMode),
    allowedTools: runtime.provider === "claude" ? buildDefaultClaudeAllowedTools() : undefined,
    temporaryAllowedTools: options.temporaryAllowedTools,
    runtimeToolCapabilities,
    claudeTools: runtime.provider === "claude" ? "default" : undefined,
    mcpGatewayUrl: options.mcpGatewayUrl,
    codexMcpInjectionEnabled: options.codexMcpInjectionEnabled,
    // Remote tasks always provide an approval callback. Claude approvals are retried
    // from returned permission denials below, so keep ordinary tasks one-shot.
    handleControlRequests: false,
    openClawEphemeralAgent: runtime.provider === "openclaw" && !sessionId,
    onApprovalRequest: options.onApprovalRequest
      ? async (request) => options.onApprovalRequest?.({
        provider: runtime.provider,
        runtimeId: runtime.id,
        sessionId: request.sessionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        contentPreview: request.contentPreview,
      }) ?? { decision: "approved" }
      : undefined,
    signal: options.signal,
  }, {
    emit: (event) => {
      for (const mapped of mapAgentRouterEvent(event)) {
        options.onEvent?.(mapped);
      }
    },
  });

  const resumeRecovery = resolveResumeSessionRecovery(runtime.provider, result.diagnostics, sessionId);
  if (resumeRecovery) {
    const sessionInvalidMessage = resumeRecovery === "poisoned"
      ? `${formatDaemonProviderLabel(runtime.provider)} session ${sessionId} was rejected by the upstream safety policy; starting a new conversation.`
      : resumeRecovery === "transport"
        ? `${formatDaemonProviderLabel(runtime.provider)} session ${sessionId} stopped responding after transport retries; starting a new conversation.`
        : `${formatDaemonProviderLabel(runtime.provider)} session ${sessionId} was not found; starting a new conversation.`;
    options.onEvent?.({
      type: "provider_session_invalid",
      content: sessionInvalidMessage,
      inputJson: {
        provider: runtime.provider,
        runtimeId: runtime.id,
        sessionId,
        code: resumeRecovery === "poisoned" ? "provider.session_poisoned" : "provider.session_invalid",
      },
    });
    options.onEvent?.({
      type: "status",
      content: sessionInvalidMessage,
    });
    clearTaskOutputArtifacts(workDir);
    return runAgentRouterProviderTask(runtime, prompt, workDir, taskTimeoutMs, {
      ...options,
      sessionId: undefined,
    });
  }

  if (runtime.provider === "claude") {
    const permissionDenials = extractClaudePermissionDenialsFromRouterEvents(result.events);
    if (permissionDenials.length > 0 && options.onApprovalRequest) {
      const allowedTools: string[] = [];
      for (const denial of permissionDenials) {
        const decision = await options.onApprovalRequest({
          provider: runtime.provider,
          runtimeId: runtime.id,
          sessionId: result.sessionId,
          toolName: denial.toolName,
          toolInput: denial.toolInput,
          contentPreview: formatClaudePermissionDenialPreview(denial),
        });
        if (decision.decision !== "approved") {
          throw buildRouterProviderFailure(
            runtime.provider,
            `Claude tool request was rejected.${decision.comment ? ` ${decision.comment}` : ""}`,
            result,
            workDir,
          );
        }
        const allowedTool = buildClaudeAllowedToolFromPermissionDenial(denial);
        if (allowedTool) {
          allowedTools.push(allowedTool);
        }
      }

      if (allowedTools.length > 0 && result.sessionId) {
        clearTaskOutputArtifacts(workDir);
        return runAgentRouterProviderTask(runtime, "用户已经在 DofeAgent 前端批准了刚才被拦截的工具调用。请从刚才中断的位置继续，重新执行已获批准的工具命令，并基于真实结果完成用户请求。", workDir, taskTimeoutMs, {
          ...options,
          sessionId: result.sessionId,
          temporaryAllowedTools: allowedTools,
        });
      }
    }
  }

  if (result.status !== "completed") {
    throw buildRouterProviderFailure(runtime.provider, buildRouterFailureMessage(runtime.provider, result), result, workDir);
  }

  const output = result.outputText?.trim();
  if (!output) {
    throw buildRouterProviderFailure(runtime.provider, `${runtime.provider} returned an empty response.`, result, workDir);
  }

  return { output, sessionId: result.sessionId };
}

function resolveAgentRouterMode(runtime: ProviderRuntimeRecord): string | undefined {
  if (runtime.provider === "codex") {
    return process.env.DOFE_AGENT_CODEX_SANDBOX?.trim() || "workspace-write";
  }
  if (runtime.provider === "openclaw") {
    return process.env.OPENCLAW_THINKING?.trim() || undefined;
  }
  return undefined;
}

function resolveCodexLaunchMode(
  runtime: ProviderRuntimeRecord,
  requestedMode: string | undefined,
): string | undefined {
  // Managed provider launchers already execute Codex in a read-only,
  // capability-dropped container without a Docker socket. Codex's own
  // workspace-write sandbox attempts to start a nested Docker container and
  // exits with code 125. The outer container is the isolation boundary.
  if (runtime.metadata.managedCredentialId) {
    return undefined;
  }
  return requestedMode ?? resolveAgentRouterMode(runtime);
}

function shouldUseCodexFullAccess(
  runtime: ProviderRuntimeRecord,
  requestedMode: string | undefined,
): boolean {
  return Boolean(runtime.metadata.managedCredentialId) || requestedMode === "danger-full-access";
}

function resolveAgentRouterSessionId(runtime: ProviderRuntimeRecord, sessionId: string | undefined): string | undefined {
  if (runtime.provider === "hermes") {
    return undefined;
  }
  return sessionId;
}

function resolveClaudePermissionMode(): string {
  return "auto";
}

function buildRuntimeToolCapabilities(options: ProviderTaskOptions): RuntimeToolCapability[] {
  return dedupeRuntimeToolCapabilities([
    ...buildBuiltinRuntimeToolCapabilities(options.contextEnv),
    ...buildCliHubRuntimeToolCapabilities(
      options.runtimeApps ?? [],
      options.runtimeAppBinDir,
      options.runtimeAppHostDiagnostics ?? true,
    ),
    ...(options.runtimeToolCapabilities ?? []),
  ]);
}

function buildBuiltinRuntimeToolCapabilities(contextEnv?: Record<string, string>): RuntimeToolCapability[] {
  const capabilities: RuntimeToolCapability[] = [
    {
      id: "dofe-agent-output",
      command: "dofe-agent",
      displayName: "DofeAgent output CLI",
      binDir: process.env.DOFE_AGENT_DAEMON_BIN ? dirname(process.env.DOFE_AGENT_DAEMON_BIN) : undefined,
      pathDirs: [
        process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT
          ? join(process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT, "bin")
          : "",
      ].filter(Boolean),
      allowedShellPatterns: [
        "dofe-agent output text *",
        "dofe-agent output attach *",
        "dofe-agent output validate *",
        "dofe-agent output preview *",
      ],
      source: "builtin",
    },
  ];

  // curl is deliberately NOT a built-in capability. Auto-injecting
  // `Bash(curl *)` into every task bypassed the task-frozen approved-capability
  // gate, and the Skill Runner runs with `--network none`, so agent-side curl
  // could not make HTTP requests anyway. A skill that needs curl declares
  // `system:curl`, which resolves through the curated system-dependency catalog
  // and the readiness/approval flow before reaching the Provider. The daemon's
  // own curl use (e.g. provider credential probing) runs through a node
  // subprocess and never touches the agent.

  const feishuLarkCliCapability = buildFeishuLarkCliDiagnosticRuntimeToolCapability({
    environment: process.env,
    source: "builtin",
  });
  if (feishuLarkCliCapability) {
    capabilities.push({
      ...feishuLarkCliCapability,
      binPath: isPathLike(feishuLarkCliCapability.command) ? feishuLarkCliCapability.command : feishuLarkCliCapability.binPath,
      binDir: resolveCommandDirFromCurrentEnv(feishuLarkCliCapability.command),
    });
  }

  return capabilities;
}

function buildCliHubRuntimeToolCapabilities(
  runtimeApps: RuntimeAppContextEntry[],
  runtimeAppBinDir?: string,
  enableHostDiagnostics = true,
): RuntimeToolCapability[] {
  if (runtimeApps.length === 0) return [];
  const pythonUserBinDir = runtimeAppBinDir?.trim() || resolveRuntimeAppUserBinDir();
  return runtimeApps.flatMap((app): RuntimeToolCapability[] => {
    const command = app.entryPoint?.trim();
    if (!command) {
      return [];
    }
    return [{
      id: `clihub:${app.source}:${app.name}`,
      command,
      displayName: app.displayName || app.name,
      binDir: runtimeAppBinDir?.trim()
        || resolveCommandDirFromCurrentEnv(command)
        || (pythonUserBinDir && existsSync(join(pythonUserBinDir, command)) ? pythonUserBinDir : undefined),
      allowedShellPatterns: [`${command} *`, `${command} --help`, `command -v ${command}`],
      diagnosticCommands: enableHostDiagnostics ? [`command -v ${shellQuote(command)}`] : undefined,
      source: "cli-hub",
    }];
  });
}

function resolveCommandDirFromCurrentEnv(command: string): string | undefined {
  if (isPathLike(command)) {
    return dirname(command);
  }
  const path = findExecutableOnPath(command);
  return path ? dirname(path) : undefined;
}

function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dedupeRuntimeToolCapabilities(capabilities: RuntimeToolCapability[]): RuntimeToolCapability[] {
  const result: RuntimeToolCapability[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const id = capability.id.trim();
    const command = capability.command.trim();
    if (!id || !command || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({
      ...capability,
      id,
      command,
      allowedShellPatterns: dedupeStrings(capability.allowedShellPatterns ?? []),
      diagnosticCommands: capability.diagnosticCommands ? dedupeStrings(capability.diagnosticCommands) : undefined,
      pathDirs: capability.pathDirs ? dedupeStrings(capability.pathDirs) : undefined,
    });
  }
  return result;
}

function mapAgentRouterEvent(event: AgentRouterEvent): ProviderTaskEvent[] {
  if (event.type === "text_delta") {
    return event.text.trim() ? [{ type: "text", content: event.text }] : [];
  }
  if (event.type === "thought_delta") {
    return event.text.trim() ? [{ type: "thinking", content: event.text }] : [];
  }
  if (event.type === "narration_delta") {
    return event.text.trim() ? [{ type: "narration", content: event.text }] : [];
  }
  if (event.type === "tool_started") {
    return [{
      type: "tool_use",
      tool: event.tool,
      content: event.title ?? event.tool,
      inputJson: event.input && typeof event.input === "object" && !Array.isArray(event.input)
        ? event.input as Record<string, unknown>
        : undefined,
      refId: event.toolUseId,
    }];
  }
  if (event.type === "tool_output" && event.tool === "usage" && event.metadata && typeof event.metadata === "object") {
    const usage = event.metadata as { input_tokens?: unknown; output_tokens?: unknown; gateway_request_id?: unknown };
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const gatewayRequestId = typeof usage.gateway_request_id === "string" && usage.gateway_request_id.trim()
      ? usage.gateway_request_id.trim()
      : undefined;
    return [{
      type: "usage",
      content: `tokens: in=${inputTokens} out=${outputTokens}`,
      inputJson: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        gateway_request_id: gatewayRequestId,
      },
    }];
  }
  if (event.type === "tool_output") {
    return [{
      type: "tool_result",
      tool: event.tool,
      content: event.output ? truncateToolOutput(event.output) : "completed",
      output: event.output ? truncateToolOutput(event.output) : undefined,
      refId: event.toolUseId,
    }];
  }
  if (event.type === "approval_requested") {
    return [{
      type: "status",
      content: `Runtime approval requested: ${event.contentPreview}`,
    }];
  }
  return [];
}

function resolveResumeSessionRecovery(
  provider: DaemonProvider,
  diagnostics: AgentRouterDiagnostic[],
  requestedSessionId: string | undefined,
): "missing" | "poisoned" | "transport" | undefined {
  if (!requestedSessionId) {
    return undefined;
  }
  const text = diagnostics
    .map((diagnostic) => `${diagnostic.message}\n${diagnostic.rawProviderMessage ?? ""}\n${diagnostic.stderrTail ?? ""}`)
    .join("\n");
  if (provider === "claude") {
    if (CLAUDE_MISSING_RESUME_SESSION_PATTERN.test(text) && text.includes(requestedSessionId)) {
      return "missing";
    }
    // A provider session can retain a context that the gateway has classified
    // as an encoding-bypass attempt. Retrying that session repeats the same
    // 400 indefinitely, while a cold conversation remains safe and usable.
    if (CLAUDE_POISONED_RESUME_SESSION_PATTERN.test(text)) {
      return "poisoned";
    }
    return undefined;
  }
  if (provider === "codex") {
    const match = CODEX_MISSING_RESUME_SESSION_PATTERN.exec(text);
    if (match?.[1] === requestedSessionId) {
      return "missing";
    }
    // A resumed Codex thread can remain addressable while its transport is no
    // longer usable. Once Codex exhausts its WebSocket and HTTPS retries, retry
    // the task once from the platform transcript instead of poisoning every
    // subsequent message with the same provider session.
    return CODEX_STALLED_RESUME_PATTERN.test(text) ? "transport" : undefined;
  }
  if (provider === "openclaw") {
    return diagnostics.some((diagnostic) => diagnostic.code === "harness.session_missing") ||
      (OPENCLAW_MISSING_RESUME_SESSION_PATTERN.test(text) && text.includes(requestedSessionId))
      ? "missing"
      : undefined;
  }
  return undefined;
}

function buildRouterFailureMessage(
  provider: DaemonProvider,
  result: Awaited<ReturnType<typeof runAgentRouter>>,
): string {
  if (result.status === "timeout") {
    const primary = result.diagnostics.find((diagnostic) => diagnostic.code === "harness.timeout") ?? result.diagnostics[0];
    return `${primary?.message || `${provider} timed out after router timeout.`} ${formatRouterDiagnosticDetails(result)}`;
  }
  const primary = result.diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? result.diagnostics[0];
  const baseMessage = primary?.message || `${provider} execution failed.`;
  return `${baseMessage} ${formatRouterDiagnosticDetails(result)}`.trim();
}

function buildRouterProviderFailure(
  provider: DaemonProvider,
  message: string,
  result: Awaited<ReturnType<typeof runAgentRouter>>,
  workDir: string,
): ProviderTaskExecutionError {
  const primary = result.diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? result.diagnostics[0];
  const code = mapRouterDiagnosticCode(provider, primary?.code, result);
  const fullMessage = message.includes("code=") ? message : `${message} ${formatRouterDiagnosticDetails(result)}`.trim();
  return new ProviderTaskExecutionError(fullMessage, {
    sessionId: result.sessionId,
    workDir,
    providerError: {
      provider,
      code,
      category: resolveRouterProviderErrorCategory(code, primary?.code),
      message: fullMessage,
      rawProviderMessage: primary?.rawProviderMessage ?? primary?.stderrTail ?? primary?.message,
    },
  });
}

function mapRouterDiagnosticCode(
  provider: DaemonProvider,
  code: AgentRouterDiagnostic["code"] | undefined,
  result: Awaited<ReturnType<typeof runAgentRouter>>,
): ProviderErrorCode {
  if (code === "harness.cli_missing") {
    return "provider.cli_missing";
  }
  if (code === "harness.auth_required" || code === "harness.auth_invalid") {
    return "provider.auth_invalid";
  }
  if (code === "harness.profile_missing") {
    return "provider.profile_missing";
  }
  if (code === "harness.model_unavailable") {
    return "provider.model_unavailable";
  }
  if (code === "harness.tool_missing") {
    return "provider.tool_missing";
  }
  if (code === "harness.tool_unauthorized") {
    return "provider.tool_unauthorized";
  }
  if (code === "harness.tool_permission_denied") {
    return "provider.tool_permission_denied";
  }
  if (code === "harness.protocol_parse_failed") {
    return "provider.protocol_parse_failed";
  }
  if (code === "harness.timeout") {
    return "provider.timeout";
  }
  if (code === "harness.session_missing") {
    return "provider.session_invalid";
  }
  if (code === "harness.empty_response") {
    return provider === "claude"
      ? resolveClaudeEmptyResponseCodeFromRouter(result)
      : "provider.empty_response";
  }
  return "provider.runtime_generic_failure";
}

function resolveClaudeEmptyResponseCodeFromRouter(result: Awaited<ReturnType<typeof runAgentRouter>>): ProviderErrorCode {
  const hasStdout = result.events.some((event) => event.type === "thought_delta" || event.type === "narration_delta" || event.type === "text_delta" || event.type === "tool_started" || event.type === "tool_output" || event.type === "approval_requested");
  const hasResultEvent = Boolean(result.sessionId) || result.events.some((event) => event.type === "session_updated");
  if (!hasStdout) {
    return "provider.empty_response.stdout_empty";
  }
  if (!hasResultEvent) {
    return "provider.empty_response.no_result_event";
  }
  return "provider.empty_response.no_text_event";
}

function resolveRouterProviderErrorCategory(
  providerCode: ProviderErrorCode,
  routerCode: AgentRouterDiagnostic["code"] | undefined,
): ProviderTaskFailureCategory {
  if (providerCode === "provider.auth_invalid") {
    return "auth";
  }
  if (providerCode === "provider.profile_missing") {
    return "profile";
  }
  if (providerCode === "provider.model_unavailable") {
    return "model";
  }
  if (providerCode === "provider.timeout" || providerCode === "provider.session_invalid") {
    return "runtime";
  }
  if (routerCode === "harness.cli_missing") {
    return "configuration";
  }
  if (providerCode === "provider.tool_missing") {
    return "configuration";
  }
  if (providerCode === "provider.tool_unauthorized" || providerCode === "provider.tool_permission_denied") {
    return "tool";
  }
  if (providerCode === "provider.protocol_parse_failed") {
    return "protocol";
  }
  if (providerCode === "provider.runtime_generic_failure") {
    return "runtime";
  }
  return "provider";
}

function formatRouterDiagnosticDetails(result: Awaited<ReturnType<typeof runAgentRouter>>): string {
  const primary = result.diagnostics.find((diagnostic) => diagnostic.severity === "error") ?? result.diagnostics[0];
  const code = primary ? mapRouterDiagnosticCode(result.harness, primary.code, result) : "provider.runtime_generic_failure";
  const parts = [
    `code=${code}`,
    `status=${result.status}`,
  ];
  if (result.status === "timeout") {
    parts.push("timedOut=true");
  }
  if (result.exitCode !== undefined) {
    parts.push(`exitCode=${result.exitCode ?? "null"}`);
  }
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  }
  if (result.sessionId) {
    parts.push(`sessionId=${result.sessionId}`);
  }
  if (primary?.stderrTail) {
    parts.push(`stderrTail=${JSON.stringify(primary.stderrTail)}`);
  }
  if (primary?.rawProviderMessage) {
    parts.push(`rawProviderMessage=${JSON.stringify(primary.rawProviderMessage)}`);
    parts.push(primary.rawProviderMessage);
  }
  return `(${parts.join("; ")})`;
}

function extractClaudePermissionDenialsFromRouterEvents(events: AgentRouterEvent[]): ClaudePermissionDenial[] {
  return events.flatMap((event) => {
    if (event.type !== "approval_requested") {
      return [];
    }
    return [{
      toolName: event.toolName,
      toolInput: event.toolInput,
    }];
  });
}

export function resolveModelId(runtime: ProviderRuntimeRecord): string | undefined {
  const providerDefinition = PROVIDER_CATALOG.find((candidate) => candidate.provider === runtime.provider);
  if (runtime.provider === "codex") return process.env.CODEX_MODEL?.trim() || undefined;
  if (runtime.provider === "claude") return process.env.CLAUDE_MODEL || providerDefinition?.defaultModelId || "claude-haiku-4-5-20251001";
  if (runtime.provider === "gemini") return process.env.GEMINI_MODEL || providerDefinition?.defaultModelId || "gemini-2.0-flash-lite";
  if (runtime.provider === "antigravity") return process.env.ANTIGRAVITY_MODEL?.trim() || undefined;
  if (runtime.provider === "opencode") return process.env.OPENCODE_MODEL || providerDefinition?.defaultModelId || "opencode-default";
  if (runtime.provider === "openclaw") return readRuntimeMetadataString(runtime, "openClawModel", "openclawModel") || process.env.OPENCLAW_MODEL?.trim() || undefined;
  if (runtime.provider === "nanobot") return process.env.NANOBOT_MODEL || providerDefinition?.defaultModelId || "nanobot-default";
  if (runtime.provider === "hermes") return process.env.HERMES_MODEL?.trim() || process.env.HERMES_INFERENCE_MODEL?.trim() || undefined;
  return providerDefinition?.defaultModelId;
}

export function readNodeMetadata(serverUrl: string, runtimeName: string, runtimes: ProviderRuntimeRecord[] = [], managedNode?: boolean): Record<string, unknown> {
  return {
    mode: managedNode ? "managed" : "remote",
    managedNode: managedNode ?? false,
    pid: String(process.pid),
    runtimeName,
    nodeVersion,
    platform,
    arch,
    serverUrl,
    cliHubReadiness: readCliHubReadiness(),
    providerHealth: Object.fromEntries(
      runtimes
        .map((runtime) => [runtime.id, readRuntimeProviderHealthMetadata(runtime)] as const)
        .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof readRuntimeProviderHealthMetadata>>] => Boolean(entry[1])),
    ),
  };
}

export function buildProviderRuntimeMetadata(
  runtime: Pick<ProviderRuntimeRecord, "provider" | "metadata">,
  options: { environment?: Record<string, string> } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    executablePath: runtime.metadata.executablePath,
    mode: runtime.metadata.mode,
  };
  if (runtime.provider === "openclaw") {
    const environment = options.environment ? { ...process.env, ...options.environment } : process.env;
    const profile = environment.OPENCLAW_PROFILE?.trim();
    const model = environment.OPENCLAW_MODEL?.trim();
    const health = inspectOpenClawDaemonAuthHealth({
      env: environment,
      profile,
      model,
    });
    return {
      ...base,
      openClawProfile: profile,
      openClawModel: model,
      providerHealth: buildOpenClawProviderHealthSnapshot(health),
    };
  }
  if (requiresProviderVerification(runtime)) {
    return {
      ...base,
      providerHealth: inspectProviderCliHealth(runtime, options.environment),
    };
  }
  return base;
}

function requiresProviderVerification(runtime: Pick<ProviderRuntimeRecord, "metadata">): boolean {
  const requestedAt = runtime.metadata.providerVerificationRequestedAt;
  if (!requestedAt) {
    return false;
  }
  const existingHealth = runtime.metadata.providerHealth as ProviderHealthSnapshot | undefined;
  if (!existingHealth?.checkedAt) {
    return true;
  }
  return new Date(existingHealth.checkedAt).getTime() < new Date(requestedAt).getTime();
}

function inspectProviderCliHealth(
  runtime: Pick<ProviderRuntimeRecord, "provider" | "metadata">,
  environment?: Record<string, string>,
): ProviderHealthSnapshot {
  const checkedAt = new Date().toISOString();
  const executablePath = runtime.metadata.executablePath.trim();
  if (!executablePath) {
    const message = `${formatDaemonProviderLabel(runtime.provider)} CLI executable is unavailable on this node.`;
    return {
      status: "broken",
      checkedAt,
      reason: message,
      error: {
        code: "provider.cli_missing",
        category: "runtime",
        provider: runtime.provider,
        message,
      },
    };
  }
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: environment ? { ...process.env, ...environment } : undefined,
  });
  if (!result.error && result.status === 0) {
    const providerRequest = inspectProviderCredentialRequest(runtime.provider, environment, checkedAt);
    if (providerRequest) return providerRequest;
    return {
      status: "healthy",
      checkedAt,
      verificationKind: "cli_preflight",
      reason: `${formatDaemonProviderLabel(runtime.provider)} CLI preflight passed.`,
    };
  }
  const errorDetails = result.error as unknown as { code?: unknown } | undefined;
  const errorCode = typeof errorDetails?.code === "string"
    ? errorDetails.code
    : undefined;
  const message = result.error?.message || result.stderr?.trim() || `${formatDaemonProviderLabel(runtime.provider)} CLI exited with status ${result.status ?? "unknown"}.`;
  return {
    status: "broken",
    checkedAt,
    reason: message,
    error: {
      code: errorCode === "ENOENT" ? "provider.cli_missing" : "provider.runtime_generic_failure",
      category: errorCode === "ENOENT" ? "runtime" : "provider",
      provider: runtime.provider,
      message,
    },
  };
}

function inspectProviderCredentialRequest(
  provider: DaemonProvider,
  environment: Record<string, string> | undefined,
  checkedAt: string,
): ProviderHealthSnapshot | null {
  if (!environment) return null;
  let apiRequest: ReturnType<typeof buildProviderCredentialProbe>;
  try {
    apiRequest = buildProviderCredentialProbe(provider, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider credential configuration is invalid.";
    return {
      status: "broken",
      checkedAt,
      verificationKind: "provider_auth",
      reason: message,
      error: {
        code: "provider.auth_invalid",
        category: "auth",
        provider,
        message,
      },
    };
  }
  if (apiRequest) {
    return executeProviderApiRequest(apiRequest, provider, environment, checkedAt);
  }
  const oauthProbe = buildOAuthCredentialProbe(provider, environment);
  if (oauthProbe) {
    return runOAuthCredentialProbe(oauthProbe, checkedAt);
  }
  const fileLoginProbe = buildFileLoginCredentialProbe(provider, environment);
  if (fileLoginProbe) {
    return runFileLoginCredentialProbe(fileLoginProbe, checkedAt);
  }
  return null;
}

/**
 * Inline child script run with the daemon's own `process.execPath`: reads
 * `{ url, headers }` from stdin and performs a single GET via the built-in
 * fetch, writing `{ ok, status }` (or `{ ok:false, error }`) to stdout. The
 * credential already lives in the header lines, so it travels through stdin and
 * never appears in the child's argv. Using Node itself removes the probe's hard
 * dependency on an external `curl` binary being installed on the host.
 */
const PROVIDER_API_PROBE_SCRIPT = `
(async () => {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  let request;
  try {
    request = JSON.parse(input);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid probe input" }));
    return;
  }
  const headers = {};
  for (const line of Array.isArray(request.headers) ? request.headers : []) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    process.stdout.write(JSON.stringify({ ok: true, status: response.status }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  }
})();
`;

function executeProviderApiRequest(
  request: { url: string; headers: string[] },
  provider: DaemonProvider,
  environment: Record<string, string>,
  checkedAt: string,
): ProviderHealthSnapshot {
  const result = spawnSync(process.execPath, ["-e", PROVIDER_API_PROBE_SCRIPT], {
    input: JSON.stringify({ url: request.url, headers: request.headers }),
    encoding: "utf8",
    timeout: 12_000,
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  let probeStatus: number | undefined;
  let probeError: string | undefined;
  if (!result.error && result.status === 0 && typeof result.stdout === "string") {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { ok?: boolean; status?: number; error?: string };
      if (parsed?.ok) {
        probeStatus = parsed.status;
      } else {
        probeError = parsed?.error;
      }
    } catch {
      // Malformed child output falls through to the generic broken snapshot.
    }
  }
  if (probeStatus !== undefined && probeStatus >= 200 && probeStatus < 300) {
    return {
      status: "healthy",
      checkedAt,
      verificationKind: "provider_request",
      reason: `${formatDaemonProviderLabel(provider)} authenticated provider request passed.`,
    };
  }
  const message = result.error?.message
    || probeError
    || result.stderr?.trim()
    || `${formatDaemonProviderLabel(provider)} provider probe returned HTTP ${
      probeStatus !== undefined && Number.isFinite(probeStatus) ? probeStatus : "unknown"
    }.`;
  return {
    status: "broken",
    checkedAt,
    verificationKind: "provider_request",
    reason: message,
    error: {
      code: "provider.runtime_generic_failure",
      category: result.error ? "runtime" : "provider",
      provider,
      message,
    },
  };
}

interface OAuthCredentialProbe {
  tokenUri?: string;
  refreshToken?: string;
  clientId?: string;
  accessToken?: string;
  sourceEnvKey: string | null;
}

function buildOAuthCredentialProbe(
  provider: DaemonProvider,
  environment: Record<string, string>,
): OAuthCredentialProbe | null {
  const sourceEnvKey = oauthCredentialEnvKey(provider);
  const raw = sourceEnvKey ? environment[sourceEnvKey]?.trim() : undefined;
  if (!raw) return null;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not JSON; treat as opaque access token if it looks like a JWT.
    return { accessToken: raw, sourceEnvKey };
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const tokenUri = typeof parsed.token_uri === "string" ? parsed.token_uri.trim()
    : typeof parsed.tokenEndpoint === "string" ? parsed.tokenEndpoint.trim()
    : undefined;
  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim()
    : typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim()
    : undefined;
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id.trim()
    : typeof parsed.clientId === "string" ? parsed.clientId.trim()
    : undefined;
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token.trim()
    : typeof parsed.accessToken === "string" ? parsed.accessToken.trim()
    : undefined;
  if (!accessToken && !refreshToken) return null;
  return { tokenUri, refreshToken, clientId, accessToken, sourceEnvKey };
}

function oauthCredentialEnvKey(provider: DaemonProvider): string | null {
  switch (provider) {
    case "claude":
      return "ANTHROPIC_AUTH_TOKEN";
    case "gemini":
      return "GOOGLE_APPLICATION_CREDENTIALS_JSON";
    case "opencode":
      return "OPENCODE_OAUTH_CREDENTIALS";
    default:
      return null;
  }
}

function runOAuthCredentialProbe(
  probe: OAuthCredentialProbe,
  checkedAt: string,
): ProviderHealthSnapshot {
  const accessToken = probe.accessToken;
  if (accessToken) {
    const expiry = tryParseJwtExpiry(accessToken);
    if (expiry && expiry.getTime() < Date.now() + 60_000) {
      const message = probe.refreshToken
        ? "OAuth access token is expired or expires within 60 seconds; refresh available."
        : "OAuth access token is expired or expires within 60 seconds and no refresh token is configured.";
      return {
        status: probe.refreshToken ? "degraded" : "broken",
        checkedAt,
        verificationKind: "oauth_probe",
        reason: message,
        error: probe.refreshToken
          ? undefined
          : {
              code: "provider.auth_invalid",
              category: "auth",
              message,
            },
      };
    }
  }
  if (!probe.accessToken && !probe.refreshToken) {
    return {
      status: "broken",
      checkedAt,
      verificationKind: "oauth_probe",
      reason: "No OAuth access token or refresh token found.",
      error: { code: "provider.auth_invalid", category: "auth", message: "No OAuth access token or refresh token found." },
    };
  }
  const checks: string[] = [];
  if (probe.clientId) checks.push("client_id present");
  if (probe.tokenUri) checks.push("token_uri present");
  if (probe.refreshToken) checks.push("refresh_token present");
  if (accessToken) checks.push(accessToken.includes(".") ? "access_token is a JWT" : "access_token present");
  return {
    status: "healthy",
    checkedAt,
    verificationKind: "oauth_probe",
    reason: `OAuth credential probe passed (${checks.join(", ")}).`,
  };
}

function tryParseJwtExpiry(token: string): Date | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    if (!exp) return undefined;
    return new Date(exp * 1000);
  } catch {
    return undefined;
  }
}

interface FileLoginCredentialProbe {
  filePath: string;
  expectedFormat: "gcloud_adc" | "generic_json" | "unknown";
}

function buildFileLoginCredentialProbe(
  provider: DaemonProvider,
  environment: Record<string, string>,
): FileLoginCredentialProbe | null {
  const envKey = fileLoginCredentialEnvKey(provider);
  const filePath = envKey ? environment[envKey]?.trim() : undefined;
  if (!filePath) return null;
  return {
    filePath,
    expectedFormat: provider === "gemini" ? "gcloud_adc" : "generic_json",
  };
}

function fileLoginCredentialEnvKey(provider: DaemonProvider): string | null {
  switch (provider) {
    case "gemini":
      return "GOOGLE_APPLICATION_CREDENTIALS";
    default:
      return null;
  }
}

function runFileLoginCredentialProbe(
  probe: FileLoginCredentialProbe,
  checkedAt: string,
): ProviderHealthSnapshot {
  if (!existsSync(probe.filePath)) {
    const message = `File-login credential file not found: ${probe.filePath}`;
    return {
      status: "broken",
      checkedAt,
      verificationKind: "file_login_probe",
      reason: message,
      error: { code: "provider.auth_invalid", category: "auth", message },
    };
  }
  let content: string;
  try {
    content = readFileSync(probe.filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : `Cannot read credential file ${probe.filePath}`;
    return {
      status: "broken",
      checkedAt,
      verificationKind: "file_login_probe",
      reason: message,
      error: { code: "provider.runtime_generic_failure", category: "runtime", message },
    };
  }
  if (probe.expectedFormat === "gcloud_adc") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const hasClientEmail = typeof parsed.client_email === "string" && parsed.client_email.length > 0;
      const hasTokenUri = typeof parsed.token_uri === "string" && parsed.token_uri.length > 0;
      if (!hasClientEmail || !hasTokenUri) {
        return {
          status: "broken",
          checkedAt,
          verificationKind: "file_login_probe",
          reason: "gcloud application-default credentials file is missing client_email or token_uri.",
          error: {
            code: "provider.auth_invalid",
            category: "auth",
            message: "gcloud application-default credentials file is missing client_email or token_uri.",
          },
        };
      }
    } catch {
      return {
        status: "broken",
        checkedAt,
        verificationKind: "file_login_probe",
        reason: "gcloud application-default credentials file is not valid JSON.",
        error: { code: "provider.auth_invalid", category: "auth", message: "gcloud application-default credentials file is not valid JSON." },
      };
    }
  }
  return {
    status: "healthy",
    checkedAt,
    verificationKind: "file_login_probe",
    reason: `File-login credential file is present and valid: ${probe.filePath}`,
  };
}

function buildProviderCredentialProbe(
  provider: DaemonProvider,
  environment: Record<string, string>,
): { url: string; headers: string[] } | null {
  if (provider === "claude") {
    const apiKey = environment.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return null;
    assertSafeProviderCredential(apiKey);
    const baseUrl = normalizeProviderApiBase(environment.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1");
    return {
      url: `${baseUrl}/models?limit=1`,
      headers: [`x-api-key: ${apiKey}`, "anthropic-version: 2023-06-01", "accept: application/json"],
    };
  }
  if (provider === "codex") {
    const apiKey = environment.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    assertSafeProviderCredential(apiKey);
    const baseUrl = normalizeProviderApiBase(environment.OPENAI_BASE_URL, "https://api.openai.com/v1");
    return {
      url: `${baseUrl}/models`,
      headers: [`Authorization: Bearer ${apiKey}`, "accept: application/json"],
    };
  }
  return null;
}

function normalizeProviderApiBase(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider base URL must use HTTP or HTTPS.");
  }
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = /\/v\d+$/.test(pathname) ? pathname : `${pathname}/v1`;
  return parsed.toString().replace(/\/$/, "");
}

function assertSafeProviderCredential(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Provider credential contains invalid control characters.");
  }
}

function readRuntimeProviderHealthMetadata(runtime: ProviderRuntimeRecord): ReturnType<typeof buildOpenClawProviderHealthSnapshot> | undefined {
  const metadata = runtime.metadata as Record<string, unknown>;
  const providerHealth = metadata.providerHealth;
  if (providerHealth && typeof providerHealth === "object" && !Array.isArray(providerHealth)) {
    return providerHealth as ReturnType<typeof buildOpenClawProviderHealthSnapshot>;
  }
  if (runtime.provider !== "openclaw") {
    return undefined;
  }
  const profile = readRuntimeMetadataString(runtime, "openClawProfile", "openclawProfile") || process.env.OPENCLAW_PROFILE?.trim() || undefined;
  const model = readRuntimeMetadataString(runtime, "openClawModel", "openclawModel") || process.env.OPENCLAW_MODEL?.trim() || undefined;
  return buildOpenClawProviderHealthSnapshot(inspectOpenClawDaemonAuthHealth({
    env: process.env,
    profile,
    model,
  }));
}

function readRuntimeMetadataString(runtime: ProviderRuntimeRecord, ...keys: string[]): string | undefined {
  const metadata = runtime.metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function buildAgentRouterProviderEnv(
  runtime: ProviderRuntimeRecord,
  extra?: Record<string, string>,
): Record<string, string> {
  const env = buildProviderEnv(runtime, extra) as Record<string, string>;
  if (runtime.provider !== "openclaw") {
    return env;
  }
  const profile = readRuntimeMetadataString(runtime, "openClawProfile", "openclawProfile");
  const model = readRuntimeMetadataString(runtime, "openClawModel", "openclawModel");
  if (profile) {
    env.DOFE_AGENT_OPENCLAW_PROFILE_OVERRIDE = profile;
  }
  if (model) {
    env.DOFE_AGENT_OPENCLAW_MODEL_OVERRIDE = model;
  }
  return env;
}

function detectProviderVersion(executablePath: string, versionArgs: string[][] = [["--version"]]): string {
  for (const args of versionArgs) {
    const result = spawnSync(executablePath, args, {
      env: process.env,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      continue;
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const firstLine = output.split(/\r?\n/)[0] ?? "";
    if (firstLine) {
      return firstLine;
    }
  }
  return "";
}

function findExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  const extensions = platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];
  for (const baseDir of pathValue.split(delimiter)) {
    for (const ext of extensions) {
      const candidate = join(baseDir, command + ext);
      if (isExecutableCandidate(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isExecutableCandidate(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findFirstExecutableOnPath(commands: string[]): string | null {
  for (const command of commands) {
    const executablePath = findExecutableOnPath(command);
    if (executablePath) {
      return executablePath;
    }
  }
  return null;
}

function resolveProviderCommands(candidate: { command?: string; commands?: string[] }): string[] {
  return candidate.commands?.length ? candidate.commands : candidate.command ? [candidate.command] : [];
}

function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

let didWarnClaudeRootRuntime = false;

function warnClaudeRootRuntimeIfNeeded(action: "detected" | "executing"): void {
  if (!isRootUser() || didWarnClaudeRootRuntime) {
    return;
  }
  didWarnClaudeRootRuntime = true;
  console.warn(
    `Claude Code runtime ${action} while dofe-agent-daemon is running as root. `
    + "Ensure /root is logged in to Claude Code and treat task commands as root-privileged.",
  );
}

interface ClaudePermissionDenial {
  toolName: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
}

function buildClaudeAllowedToolFromPermissionDenial(denial: ClaudePermissionDenial): string | undefined {
  if (denial.toolName !== "Bash") {
    return denial.toolName && denial.toolName !== "unknown" ? denial.toolName : undefined;
  }
  const command = typeof denial.toolInput?.command === "string" ? denial.toolInput.command.trim() : "";
  return command ? `Bash(${command})` : "Bash(*)";
}

function formatClaudePermissionDenialPreview(denial: ClaudePermissionDenial): string {
  return formatToolApprovalPreview(denial.toolName, denial.toolInput);
}

function formatToolApprovalPreview(toolName: string, toolInput?: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput?.command === "string") {
    return `Bash: ${toolInput.command}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput ?? {})}`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

async function runGeminiProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  taskTimeoutMs: number,
  options: ProviderTaskOptions,
): Promise<{ output: string; sessionId?: string }> {
  clearTaskOutputArtifacts(workDir);
  const outputFile = join(workDir, "last-message.txt");
  const model = (options.modelId ?? process.env.GEMINI_MODEL) || "gemini-2.0-flash-lite";
  const providerArgs = ["--model", model, "--sandbox", "-y", prompt];
  const sandbox = await connectSandbox({
    runtimeId: runtime.id,
    workDir,
  });
  let finalOutput = "";
  let stderr = "";
  let stdoutBuffer = "";
  const providerEnv = buildProviderEnv(runtime, options.contextEnv);
  const redactions = buildProviderRedactions(providerEnv, options.skillEnvKeys);
  const result = await sandbox.exec({
    command: runtime.metadata.executablePath,
    args: providerArgs,
    timeoutMs: taskTimeoutMs,
    env: providerEnv,
    onStdout: (chunk) => {
      const value = redactText(chunk, redactions);
      stdoutBuffer += value;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed.startsWith("{")) {
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            for (const mapped of mapGeminiEvent(event)) {
              options.onEvent?.(mapped);
            }
            continue;
          } catch {
            // Fall through and treat as output.
          }
        }

        finalOutput += (finalOutput ? "\n" : "") + trimmed;
      }
    },
    onStderr: (chunk) => {
      stderr += redactText(chunk, redactions);
    },
  });

  if (stdoutBuffer.trim()) {
    finalOutput += (finalOutput ? "\n" : "") + stdoutBuffer.trim();
  }
  if (result.timedOut) {
    throw new Error(`gemini timed out after ${taskTimeoutMs}ms.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(stderr.trim() || `gemini exited with code ${result.exitCode}.`);
  }

  if (finalOutput) {
    writeFileSync(outputFile, finalOutput, "utf8");
  }

  const output = finalOutput || (existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "");
  if (!output) {
    throw new Error("gemini returned an empty response.");
  }

  return { output };
}

async function runNanoBotProviderTask(
  runtime: ProviderRuntimeRecord,
  prompt: string,
  workDir: string,
  taskTimeoutMs: number,
  options: ProviderTaskOptions,
): Promise<{ output: string; sessionId?: string }> {
  clearTaskOutputArtifacts(workDir);
  const outputFile = join(workDir, "last-message.txt");
  const configPath = process.env.NANOBOT_CONFIG_PATH?.trim() || process.env.NANOBOT_CONFIG?.trim();
  const providerArgs = ["agent", "-w", workDir, "-m", prompt, "--no-markdown"];
  if (configPath) {
    providerArgs.splice(1, 0, "-c", configPath);
  }

  let stderr = "";
  const result = await execProviderCommand(runtime, providerArgs, workDir, taskTimeoutMs, buildNanoBotEnv(runtime, options.contextEnv), options.skillEnvKeys, {
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });

  if (result.result.timedOut) {
    throw new Error(`nanobot timed out after ${taskTimeoutMs}ms.`);
  }
  if (result.result.exitCode !== 0) {
    throw new Error(stderr.trim() || `nanobot exited with code ${result.result.exitCode}.`);
  }

  const output = result.stdout.trim();
  if (output) {
    writeFileSync(outputFile, output, "utf8");
  }

  if (!output) {
    throw new Error("nanobot returned an empty response.");
  }

  return { output };
}

function mapGeminiEvent(event: Record<string, unknown>): ProviderTaskEvent[] {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "tool_call" || type === "function_call") {
    return [{
      type: "tool_use",
      tool: typeof event.name === "string" ? event.name : "unknown",
      content: typeof event.name === "string" ? event.name : "tool call",
      inputJson: typeof event.input === "object" && event.input ? event.input as Record<string, unknown> : undefined,
      refId: readProviderRefId(event),
    }];
  }

  if (type === "tool_result" || type === "function_response") {
    return [{
      type: "tool_result",
      tool: typeof event.name === "string" ? event.name : undefined,
      content: typeof event.output === "string" ? truncateToolOutput(event.output) : "completed",
      output: typeof event.output === "string" ? truncateToolOutput(event.output) : undefined,
      refId: readProviderRefId(event),
    }];
  }

  return [];
}

function readProviderRefId(value: Record<string, unknown>): string | undefined {
  for (const key of ["id", "tool_use_id", "toolUseId", "call_id", "callId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function truncateToolOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 20000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 19997)}...`;
}

function buildProviderEnv(runtime: ProviderRuntimeRecord, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (runtime.metadata.managedCredentialId) {
    // A managed Runtime must never inherit host provider credentials. Its
    // task-scoped credential bundle below is the only source of model auth.
    for (const key of MANAGED_PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS) {
      // Agent Router builds a fresh base from process.env. An explicit empty
      // value survives that second merge and prevents it restoring host keys.
      env[key] = "";
    }
  }
  const currentPath = extra?.PATH ?? env.PATH ?? "";
  env.PATH = ensureProviderPath(currentPath, runtime);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value !== "string") {
        continue;
      }
      env[key] = key === "PATH" ? ensureProviderPath(value, runtime) : value;
    }
  }
  for (const key of Object.keys(env)) {
    if (isDaemonOnlyProviderEnvironmentKey(key)) {
      delete env[key];
    }
  }
  return env;
}

const MANAGED_PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCLAW_API_KEY",
  "NANOBOT_API_KEY",
  "HERMES_API_KEY",
];

// Builds value-based redaction patterns for every secret-named entry in the
// provider env, mirroring the agent-router path (see buildRedactions). Used to
// scrub secret values from provider stdout/stderr before they are stored,
// streamed to clients, or surfaced in error diagnostics.
function buildProviderRedactions(env: NodeJS.ProcessEnv, skillEnvKeys?: readonly string[]) {
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      stringEnv[key] = value;
    }
  }
  return [...buildRedactions(stringEnv), ...buildEnvValueRedactions(stringEnv, skillEnvKeys)];
}

function ensureProviderPath(pathValue: string, runtime: ProviderRuntimeRecord): string {
  const runtimeBinDirs = dedupeStrings([
    dirname(runtime.metadata.executablePath),
    process.env.DOFE_AGENT_DAEMON_BIN ? dirname(process.env.DOFE_AGENT_DAEMON_BIN) : "",
    process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT ? join(process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT, "bin") : "",
  ]);
  const parts = pathValue.split(delimiter).filter(Boolean);
  const existing = parts.filter((part) => !runtimeBinDirs.includes(part));
  return [...runtimeBinDirs, ...existing].filter(Boolean).join(delimiter);
}

async function execProviderCommand(
  runtime: ProviderRuntimeRecord,
  args: string[],
  workDir: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  skillEnvKeys?: readonly string[],
  callbacks?: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Awaited<ReturnType<typeof connectSandbox>>["exec"]>>;
}> {
  const sandbox = await connectSandbox({
    runtimeId: runtime.id,
    workDir,
  });

  const providerEnv = buildProviderEnv(runtime, env);
  const redactions = buildProviderRedactions(providerEnv, skillEnvKeys);
  let stdout = "";
  let stderr = "";
  const result = await sandbox.exec({
    command: runtime.metadata.executablePath,
    args,
    timeoutMs,
    env: providerEnv,
    onStdout: (chunk) => {
      const value = redactText(chunk, redactions);
      stdout += value;
      callbacks?.onStdout?.(value);
    },
    onStderr: (chunk) => {
      const value = redactText(chunk, redactions);
      stderr += value;
      callbacks?.onStderr?.(value);
    },
  });

  return { stdout, stderr, result };
}

function buildNanoBotEnv(runtime: ProviderRuntimeRecord, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildProviderEnv(runtime, extra);

  const model = process.env.NANOBOT_MODEL?.trim();
  if (model && !env.NANOBOT_AGENTS__DEFAULTS__MODEL) {
    env.NANOBOT_AGENTS__DEFAULTS__MODEL = model;
  }

  return env;
}

export function readProviderTaskFailureMetadata(error: unknown): {
  sessionId?: string;
  workDir?: string;
  providerError?: ProviderTaskStructuredError;
} | undefined {
  if (!(error instanceof ProviderTaskExecutionError)) {
    return undefined;
  }

  return {
    sessionId: error.sessionId,
    workDir: error.workDir,
    providerError: error.providerError,
  };
}

export function normalizeProviderTaskErrorCategory(
  category: ProviderTaskStructuredError["category"] | undefined,
): ProviderErrorCategory | undefined {
  return (
    category === "provider" ||
    category === "runtime" ||
    category === "configuration" ||
    category === "auth" ||
    category === "profile" ||
    category === "model" ||
    category === "tool" ||
    category === "protocol" ||
    category === "unknown"
  )
    ? category
    : undefined;
}
