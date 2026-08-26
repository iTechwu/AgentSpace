// 3.5-4：自 provider-runtime.ts 拆出——agent-router 事件映射、resume 会话
// 失效判定、失败分类（code/category/诊断明细）与 Claude 审批拒绝处理。
import type { DaemonProvider, ProviderErrorCode } from "@dofe-agent/domain";
import type { AgentRouterDiagnostic, AgentRouterEvent } from "../agent-router/index.ts";
import type { runAgentRouter } from "../agent-router/index.ts";
import { ProviderTaskExecutionError, type ProviderTaskEvent, type ProviderTaskFailureCategory } from "./types.ts";

const CLAUDE_MISSING_RESUME_SESSION_PATTERN = /No conversation found with session ID:/i;
const CLAUDE_POISONED_RESUME_SESSION_PATTERN = /prompt injection detected[\s\S]*encoding_bypass|encoding_bypass[\s\S]*prompt injection detected/i;
const CODEX_MISSING_RESUME_SESSION_PATTERN = /no rollout found for thread id\s+([^\s)]+)/i;
const CODEX_STALLED_RESUME_PATTERN = /falling back from websockets to https transport[\s\S]*request timed out/i;
const OPENCLAW_MISSING_RESUME_SESSION_PATTERN = /session .*not found|session.*missing|conversation .*not found|conversation.*missing|agent .*not found|agent.*missing|unknown session/i;

export function mapAgentRouterEvent(event: AgentRouterEvent): ProviderTaskEvent[] {
  if (event.type === "harness_started") {
    const label = event.harness === "deepseek-harness" ? "DeepSeek Harness" : event.harness;
    return [{
      type: "status",
      content: `${label} started; executing the task.`,
      inputJson: { harness: event.harness, pid: event.pid },
    }];
  }
  if (event.type === "text_delta") {
    return event.text ? [{ type: "text", content: event.text }] : [];
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
    const usage = event.metadata as {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_tokens?: unknown;
      cache_write_tokens?: unknown;
      reasoning_tokens?: unknown;
      gateway_request_id?: unknown;
    };
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const cacheReadTokens = readOptionalTokenCount(usage.cache_read_tokens);
    const cacheWriteTokens = readOptionalTokenCount(usage.cache_write_tokens);
    const reasoningTokens = readOptionalTokenCount(usage.reasoning_tokens);
    const gatewayRequestId = typeof usage.gateway_request_id === "string" && usage.gateway_request_id.trim()
      ? usage.gateway_request_id.trim()
      : undefined;
    return [{
      type: "usage",
      content: `tokens: in=${inputTokens} out=${outputTokens}`,
      inputJson: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        reasoning_tokens: reasoningTokens,
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

function readOptionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resolveResumeSessionRecovery(
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

export function buildRouterFailureMessage(
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

export function buildRouterProviderFailure(
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

interface ClaudePermissionDenial {
  toolName: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
}

export function buildClaudeAllowedToolFromPermissionDenial(denial: ClaudePermissionDenial): string | undefined {
  if (denial.toolName !== "Bash") {
    return denial.toolName && denial.toolName !== "unknown" ? denial.toolName : undefined;
  }
  const command = typeof denial.toolInput?.command === "string" ? denial.toolInput.command.trim() : "";
  return command ? `Bash(${command})` : "Bash(*)";
}

export function formatClaudePermissionDenialPreview(denial: ClaudePermissionDenial): string {
  return formatToolApprovalPreview(denial.toolName, denial.toolInput);
}

function formatToolApprovalPreview(toolName: string, toolInput?: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof toolInput?.command === "string") {
    return `Bash: ${toolInput.command}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput ?? {})}`;
}

export function extractClaudePermissionDenialsFromRouterEvents(events: AgentRouterEvent[]): ClaudePermissionDenial[] {
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

export function truncateToolOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 20000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 19997)}...`;
}
