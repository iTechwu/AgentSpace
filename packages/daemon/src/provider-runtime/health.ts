// 3.5-4：自 provider-runtime.ts 拆出——provider 健康验证：CLI preflight、
// API key/OAuth/文件登录三类凭据探测与快照构建。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { DaemonProvider, ProviderHealthSnapshot } from "@dofe-agent/domain";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ProviderRuntimeRecord } from "./types.ts";

export function requiresProviderVerification(runtime: Pick<ProviderRuntimeRecord, "metadata">): boolean {
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

export function inspectProviderCliHealth(
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
