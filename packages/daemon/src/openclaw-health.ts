import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderHealthSnapshot } from "@dofe-agent/domain";

export type OpenClawHealthStatus = "healthy" | "degraded" | "broken" | "unknown";
export type OpenClawProviderErrorCategory =
  | "auth"
  | "profile"
  | "model"
  | "tool"
  | "protocol"
  | "runtime"
  | "configuration";
export type OpenClawProviderErrorCode =
  | "provider.cli_missing"
  | "provider.auth_invalid"
  | "provider.profile_missing"
  | "provider.model_unavailable"
  | "provider.session_invalid"
  | "provider.tool_missing"
  | "provider.tool_unauthorized"
  | "provider.tool_permission_denied"
  | "provider.empty_response"
  | "provider.protocol_parse_failed"
  | "provider.timeout"
  | "provider.runtime_generic_failure";

export interface OpenClawProviderError {
  provider: "openclaw";
  code: OpenClawProviderErrorCode;
  category: OpenClawProviderErrorCategory;
  message: string;
  rawProviderMessage: string;
}

export interface OpenClawDaemonAuthHealth {
  provider: "openclaw";
  status: OpenClawHealthStatus;
  usable: boolean;
  checkedAt: string;
  authSource: {
    profile?: string;
    openclawConfigPath: string;
    authProfilesPath?: string;
    modelsPath?: string;
  };
  error?: OpenClawProviderError;
  details: {
    profile?: string;
    model?: string;
    hasExplicitConfigPath: boolean;
    hasOpenClawConfig: boolean;
    hasTaskAuthProfiles: boolean;
    hasTaskModels: boolean;
    hasGatewayCredentials: boolean;
    requiresTaskFiles: boolean;
    authProfileCount?: number;
  };
}

export function inspectOpenClawDaemonAuthHealth(input: {
  workDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  profile?: string;
  model?: string;
  requireTaskFiles?: boolean;
  now?: Date;
} = {}): OpenClawDaemonAuthHealth {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? env.HOME ?? homedir();
  const profile = input.profile?.trim() || env.OPENCLAW_PROFILE?.trim() || undefined;
  const model = input.model?.trim() || env.OPENCLAW_MODEL?.trim() || undefined;
  const explicitConfigPath = env.OPENCLAW_CONFIG_PATH?.trim() || undefined;
  const openclawConfigPath = explicitConfigPath ?? join(homeDir, profile ? `.openclaw-${profile}` : ".openclaw", "openclaw.json");
  const authProfilesPath = input.workDir ? join(input.workDir, "agent", "auth-profiles.json") : undefined;
  const modelsPath = input.workDir ? join(input.workDir, "agent", "models.json") : undefined;
  const hasOpenClawConfig = existsSync(openclawConfigPath);
  const authProfiles = authProfilesPath ? readJsonObject(authProfilesPath) : undefined;
  const models = modelsPath ? readJsonObject(modelsPath) : undefined;
  const authProfileCount = authProfiles ? countProfiles(authProfiles) : undefined;
  const hasTaskAuthProfiles = (authProfileCount ?? 0) > 0;
  const hasTaskModels = Boolean(models && Object.keys(models).length > 0);
  const hasGatewayCredentials = Boolean(env.OPENAI_API_KEY?.trim() && env.OPENAI_BASE_URL?.trim());
  const requiresTaskFiles = input.requireTaskFiles ?? (Boolean(input.workDir) || isDaemonTaskWorkDir(input.workDir, env));
  const checkedAt = (input.now ?? new Date()).toISOString();

  const base = {
    provider: "openclaw" as const,
    checkedAt,
    authSource: {
      profile,
      openclawConfigPath,
      authProfilesPath,
      modelsPath,
    },
    details: {
      profile,
      model,
      hasExplicitConfigPath: Boolean(explicitConfigPath),
      hasOpenClawConfig,
      hasTaskAuthProfiles,
      hasTaskModels,
      hasGatewayCredentials,
      requiresTaskFiles,
      authProfileCount,
    },
  };

  // Managed runtimes authenticate each task through the private gateway instead
  // of the daemon user's persistent OpenClaw profile.
  if (hasGatewayCredentials) {
    return {
      ...base,
      status: "healthy",
      usable: true,
    };
  }

  if (requiresTaskFiles && hasTaskAuthProfiles && hasTaskModels) {
    return {
      ...base,
      status: "healthy",
      usable: true,
    };
  }

  if (requiresTaskFiles && !hasTaskAuthProfiles) {
    return {
      ...base,
      status: "broken",
      usable: false,
      error: buildOpenClawError(
        "provider.profile_missing",
        "profile",
        "OpenClaw task auth profile is missing; daemon copied files are not sufficient for execution.",
      ),
    };
  }

  if (requiresTaskFiles && !hasTaskModels) {
    return {
      ...base,
      status: "broken",
      usable: false,
      error: buildOpenClawError(
        "provider.model_unavailable",
        "model",
        "OpenClaw task model mapping is missing; daemon cannot prove the provider/model route is usable.",
      ),
    };
  }

  if (profile || hasOpenClawConfig) {
    return {
      ...base,
      status: "degraded",
      usable: true,
      error: buildOpenClawError(
        "provider.profile_missing",
        "profile",
        "OpenClaw config exists, but task-local auth/model files have not been verified yet.",
      ),
    };
  }

  if (input.requireTaskFiles === false) {
    return {
      ...base,
      status: "unknown",
      usable: false,
    };
  }

  return {
    ...base,
    status: "broken",
    usable: false,
    error: buildOpenClawError(
      "provider.profile_missing",
      "profile",
      "OpenClaw auth profile is missing for the daemon user.",
    ),
  };
}

export function buildOpenClawProviderHealthSnapshot(health: OpenClawDaemonAuthHealth): ProviderHealthSnapshot {
  const reason = health.error?.message ?? (
    health.status === "healthy"
      ? "OpenClaw provider preflight passed."
      : health.status === "degraded"
        ? "OpenClaw provider is available but task-local auth/model files have not been verified."
        : health.status === "unknown"
          ? "OpenClaw provider health has not been checked."
          : "OpenClaw provider is currently unavailable."
  );

  return {
    status: health.status,
    reason,
    checkedAt: health.checkedAt,
    error: health.error
      ? {
          provider: "openclaw",
          code: health.error.code,
          category: health.error.category,
          message: health.error.message,
          rawProviderMessage: health.error.rawProviderMessage,
        }
      : undefined,
  };
}

export function normalizeOpenClawProviderError(rawMessage: string): OpenClawProviderError | undefined {
  const trimmed = sanitizeOpenClawDiagnosticOutput(rawMessage.trim());
  if (!trimmed) {
    return undefined;
  }

  if (/\b401\b|user not found|unauthorized|invalid api key|authentication failed|auth(?:orization)? failed/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.auth_invalid",
      "auth",
      "OpenClaw 当前不可用：认证失败，请检查 daemon 继承的 OpenClaw/OpenRouter profile。",
      trimmed,
    );
  }

  if (/session .*not found|session.*missing|conversation .*not found|conversation.*missing|agent .*not found|agent.*missing|unknown session/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.session_invalid",
      "runtime",
      "OpenClaw 当前会话不可用：旧 session/conversation/agent 不存在，需要重新开启会话。",
      trimmed,
    );
  }

  if (/auth-profiles\.json|profile .*not found|profile.*missing|missing .*profile|no auth profiles?/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.profile_missing",
      "profile",
      "OpenClaw 当前不可用：daemon 执行目录缺少可用 auth profile。",
      trimmed,
    );
  }

  if (/model .*not found|model.*unavailable|provider .*not found|no such model|model .*denied|unknown model|invalid model/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.model_unavailable",
      "model",
      "OpenClaw 当前不可用：当前 profile 无法使用配置的 provider/model。",
      trimmed,
    );
  }

  if (/command not found|no such file or directory|tool .*not found|missing .*tool|executable .*not found|not in path/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.tool_missing",
      "tool",
      "OpenClaw 当前不可用：任务需要的 CLI/tool 不存在或不在 PATH。",
      trimmed,
    );
  }

  if (/tool .*unauthorized|not authorized|workspace grant|permission .*required|requires approval/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.tool_unauthorized",
      "tool",
      "OpenClaw 当前不可用：任务需要的 tool 未被授权。",
      trimmed,
    );
  }

  if (/permission denied|operation not permitted|tool .*denied|provider rejected .*tool|tool call rejected/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.tool_permission_denied",
      "tool",
      "OpenClaw 当前不可用：provider 拒绝了 tool 调用。",
      trimmed,
    );
  }

  if (/invalid json|json parse|parse.*json|protocol/i.test(trimmed)) {
    return buildOpenClawError(
      "provider.protocol_parse_failed",
      "protocol",
      "OpenClaw 输出协议无法解析。",
      trimmed,
    );
  }

  return undefined;
}

function buildOpenClawError(
  code: OpenClawProviderErrorCode,
  category: OpenClawProviderErrorCategory,
  message: string,
  rawProviderMessage = message,
): OpenClawProviderError {
  return {
    provider: "openclaw",
    code,
    category,
    message,
    rawProviderMessage: sanitizeOpenClawDiagnosticOutput(rawProviderMessage),
  };
}

function isDaemonTaskWorkDir(workDir: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (env.DOFE_AGENT_CONTEXT_TASK_ID?.trim()) {
    return true;
  }
  if (!workDir) {
    return false;
  }
  return existsSync(join(workDir, "task.json")) || existsSync(join(workDir, "prompt.txt"));
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function countProfiles(value: Record<string, unknown>): number {
  const profiles = value.profiles;
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    return Object.keys(profiles).length;
  }

  return Object.keys(value).length;
}

function sanitizeOpenClawDiagnosticOutput(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-secret]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|AUTH)[A-Z0-9_]*\s*=\s*)[^\s"']+/gi, "$1[redacted]")
    .replace(/([?&](?:access_token|refresh_token|token|api_key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/("(?:token|accessToken|refreshToken|apiKey|api_key|secret|profileSecret|profile_secret|authorization)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/(Authorization:\s*)[^\r\n]+/gi, "$1[redacted]");
}
