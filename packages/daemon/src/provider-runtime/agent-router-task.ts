// 3.5-4：自 provider-runtime.ts 拆出——runProviderTask 分发与 agent-router
// 执行主流程（resume 恢复、Claude 审批拒绝重试、空响应失败）。
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { resolveSandboxTaskTimeoutMs } from "@dofe-agent/sandbox";
import {
  buildDefaultClaudeAllowedTools,
  runAgentRouter,
  type AgentRouterHarness,
} from "../agent-router/index.ts";
import { clearTaskOutputArtifacts } from "../bundle.ts";
import { resolveModelId } from "./catalog.ts";
import { buildAgentRouterProviderEnv, readRuntimeProviderHealthMetadata } from "./metadata.ts";
import {
  buildClaudeAllowedToolFromPermissionDenial,
  buildRouterFailureMessage,
  buildRouterProviderFailure,
  extractClaudePermissionDenialsFromRouterEvents,
  formatClaudePermissionDenialPreview,
  mapAgentRouterEvent,
  resolveResumeSessionRecovery,
} from "./router-diagnostics.ts";
import { runGeminiProviderTask, runNanoBotProviderTask } from "./legacy-runtime.ts";
import { buildRuntimeToolCapabilities } from "./tool-capabilities.ts";
import type { ProviderRuntimeRecord, ProviderTaskOptions } from "./types.ts";

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
  const codexLaunchMode = runtime.provider === "codex"
    ? resolveCodexLaunchMode(runtime, options.executionPolicy?.codexSandboxMode)
    : undefined;
  const result = await runAgentRouter({
    version: 1,
    harness,
    prompt,
    cwd: workDir,
    executablePath: runtime.metadata.executablePath,
    model: options.modelId ?? resolveModelId(runtime),
    mode: runtime.provider === "codex" ? codexLaunchMode : resolveAgentRouterMode(runtime),
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
    codexFullAccess: runtime.provider === "codex" && shouldUseCodexFullAccess(runtime, codexLaunchMode),
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
    return process.env.DOFE_AGENT_CODEX_SANDBOX?.trim() || "danger-full-access";
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
