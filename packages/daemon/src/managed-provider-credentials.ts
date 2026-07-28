import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import type { DaemonProvider } from "@dofe-agent/domain";
import type { ManagedCredentialBundleDocument } from "./daemon-api.ts";
import { cleanupCredentialProfile, writeCredentialProfile, type ProviderCredentialProfile } from "./provider-credentials.ts";

export interface ManagedCredentialResolver {
  resolve(runtimeId: string, expectedCredentialId?: string): Promise<ProviderCredentialProfile | null>;
  getExecutablePath(runtimeId: string, provider: DaemonProvider): string;
  cleanup(runtimeId: string): void;
}

const ALLOWED_ENVIRONMENT_KEYS = new Set([
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
]);

const PROVIDER_EXECUTABLES: Record<DaemonProvider, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  gemini: "gemini",
  opencode: "opencode",
  openclaw: "openclaw",
  nanobot: "nanobot",
  hermes: "hermes-agent",
};

const PROVIDER_ENVIRONMENT_KEYS: Record<DaemonProvider, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"],
  antigravity: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  gemini: ["GEMINI_API_KEY", "GEMINI_BASE_URL", "GOOGLE_API_KEY"],
  opencode: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENCODE_API_KEY"],
  openclaw: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENCLAW_API_KEY"],
  nanobot: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "NANOBOT_API_KEY"],
  hermes: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "HERMES_API_KEY"],
};

const PROVIDER_BASE_URL_KEYS: Record<DaemonProvider, string> = {
  claude: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
  antigravity: "OPENAI_BASE_URL",
  gemini: "GEMINI_BASE_URL",
  opencode: "OPENAI_BASE_URL",
  openclaw: "OPENAI_BASE_URL",
  nanobot: "OPENAI_BASE_URL",
  hermes: "OPENAI_BASE_URL",
};

const ATTRIBUTION_ENVIRONMENT_KEYS = [
  "DOFE_AGENT_RUNTIME_CREDENTIAL_ID",
  "DOFE_AGENT_RUNTIME_ID",
  "DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID",
  "DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID",
  "DOFE_AGENT_GATEWAY_REQUEST_LOG",
] as const;

const ATTRIBUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildManagedRuntimeAttributionHeaders(input: {
  runtimeKey: string;
  runtimeCredentialId: string;
  runtimeId: string;
  employeeId: string;
  conversationId: string;
  timestampSeconds: number;
}): Record<string, string> {
  if (!ATTRIBUTION_ID_PATTERN.test(input.employeeId) || !ATTRIBUTION_ID_PATTERN.test(input.conversationId)) {
    throw new Error("managed_runtime.invalid_attribution_id");
  }
  const timestamp = String(input.timestampSeconds);
  const content = [input.runtimeCredentialId, input.runtimeId, input.employeeId, input.conversationId, timestamp].join("\n");
  return {
    "x-dofe-employee-id": input.employeeId,
    "x-dofe-conversation-id": input.conversationId,
    "x-dofe-attribution-timestamp": timestamp,
    "x-dofe-attribution-signature": createHmac("sha256", input.runtimeKey).update(content, "utf8").digest("hex"),
  };
}

export function getManagedProviderCredentialEnvironmentKey(provider: DaemonProvider): string {
  const key = PROVIDER_ENVIRONMENT_KEYS[provider].find((candidate) => candidate.endsWith("_API_KEY"));
  if (!key) {
    throw new Error(`managed_runtime.credential_env_key_missing:${provider}`);
  }
  return key;
}

export function createManagedCredentialResolver(
  stateDir: string,
  fetchBundle: (runtimeId: string) => Promise<ManagedCredentialBundleDocument>,
): ManagedCredentialResolver {
  const cache = new Map<string, { credentialId: string; profile: ProviderCredentialProfile }>();

  async function resolve(runtimeId: string, expectedCredentialId?: string): Promise<ProviderCredentialProfile | null> {
    const cached = cache.get(runtimeId);
    if (cached && (!expectedCredentialId || cached.credentialId === expectedCredentialId)) {
      return cached.profile;
    }

    const bundle = await fetchBundle(runtimeId);
    if (bundle.version !== 1) {
      throw new Error(`managed_runtime.unsupported_credential_bundle_version:${bundle.version}`);
    }
    if (!bundle.credentialId) {
      throw new Error("managed_runtime.credential_bundle_id_missing");
    }
    if (expectedCredentialId && bundle.credentialId !== expectedCredentialId) {
      throw new Error(`managed_runtime.credential_bundle_id_mismatch:${runtimeId}`);
    }

    const profileDir = pathResolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    const runtimeHomeDir = join(profileDir, "home");
    mkdirSync(runtimeHomeDir, { recursive: true, mode: 0o700 });
    chmodSync(runtimeHomeDir, 0o700);
    const filteredEnvironment: Record<string, string> = {};
    for (const [key, value] of Object.entries(bundle.environment)) {
      if (!ALLOWED_ENVIRONMENT_KEYS.has(key)) {
        throw new Error(`managed_runtime.disallowed_credential_env_key:${key}`);
      }
      filteredEnvironment[key] = value;
    }
    const runtimeKey = Object.entries(filteredEnvironment)
      .find(([key]) => key.endsWith("_API_KEY"))?.[1];
    if (!runtimeKey) {
      throw new Error("managed_runtime.credential_api_key_missing");
    }
    const document = {
      version: 1,
      environment: filteredEnvironment,
      files: {
        ...bundle.files,
        "runtime-key": runtimeKey,
      },
    };
    const profile = writeCredentialProfile(profileDir, document);
    writeFileSync(join(profile.profileDir, "attribution-proxy.mjs"), buildAttributionProxySource(), {
      encoding: "utf8",
      mode: 0o644,
    });
    const managedProfile: ProviderCredentialProfile = {
      accountId: runtimeId,
      profileDir: profile.profileDir,
      environment: profile.environment,
    };
    cache.set(runtimeId, { credentialId: bundle.credentialId, profile: managedProfile });
    return managedProfile;
  }

  function cleanup(runtimeId: string): void {
    cache.delete(runtimeId);
    const profileDir = pathResolve(stateDir, "managed-runtimes", normalizeRuntimeId(runtimeId));
    cleanupCredentialProfile(profileDir);
  }

  function getExecutablePath(runtimeId: string, provider: DaemonProvider): string {
    const profileDir = cache.get(runtimeId)?.profile.profileDir;
    if (!profileDir) {
      throw new Error(`managed_runtime.credential_profile_missing:${runtimeId}`);
    }
    const launcherPath = join(dirname(profileDir), "run-provider");
    writeFileSync(launcherPath, buildDockerProviderLauncher(profileDir, runtimeId, provider), {
      encoding: "utf8",
      mode: 0o700,
    });
    chmodSync(launcherPath, 0o700);
    return launcherPath;
  }

  return { resolve, getExecutablePath, cleanup };
}

function buildDockerProviderLauncher(profileDir: string, runtimeId: string, provider: DaemonProvider): string {
  const imageTag = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest";
  const image = `dofe/agent-runtime-${provider}:${imageTag}`;
  const runtimeHomeDir = join(dirname(profileDir), "home");
  const environmentArgs = [PROVIDER_BASE_URL_KEYS[provider], ...ATTRIBUTION_ENVIRONMENT_KEYS]
    .map((key) => `  --env ${key} \\\n`)
    .join("");
  return [
    "#!/bin/sh",
    "set -eu",
    "exec docker run --rm --init \\",
    "  --read-only \\",
    "  --tmpfs /tmp:rw,nosuid,nodev,noexec \\",
    "  --security-opt no-new-privileges \\",
    "  --cap-drop ALL \\",
    "  --user \"$(id -u):$(id -g)\" \\",
    `  --name ${shellQuote(`dofe-runtime-${normalizeRuntimeId(runtimeId)}`)} \\`,
    "  --mount \\\"type=bind,src=$(pwd),dst=/workspace\\\" \\",
    `  --mount ${shellQuote(`type=bind,src=${profileDir},dst=/dofe-profile,readonly`)} \\`,
    `  --mount ${shellQuote(`type=bind,src=${runtimeHomeDir},dst=/dofe-home`)} \\`,
    "  --workdir /workspace \\",
    "  --env HOME=/dofe-home \\",
    environmentArgs.trimEnd(),
    `  ${shellQuote(image)} node /dofe-profile/attribution-proxy.mjs ${shellQuote(PROVIDER_BASE_URL_KEYS[provider])} ${shellQuote(getManagedProviderCredentialEnvironmentKey(provider))} /dofe-profile/runtime-key ${shellQuote(PROVIDER_EXECUTABLES[provider])} \"$@\"`,
    "",
  ].join("\n");
}

function buildAttributionProxySource(): string {
  return `import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const [baseUrlKey, runtimeKeyName, runtimeKeyPath, executable, ...args] = process.argv.slice(2);
const upstreamBaseUrl = process.env[baseUrlKey];
const runtimeKey = readFileSync(runtimeKeyPath, "utf8").trim();
if (!upstreamBaseUrl || !runtimeKeyName || !runtimeKey || !executable) {
  console.error("managed_runtime.attribution_proxy_configuration_missing");
  process.exit(1);
}

const upstream = new URL(upstreamBaseUrl);
const basePath = upstream.pathname.replace(/\\\/$/, "");
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const server = http.createServer((request, response) => {
  let requestPath = request.url || "/";
  if (basePath && requestPath !== basePath && !requestPath.startsWith(basePath + "/")) {
    requestPath = basePath + (requestPath.startsWith("/") ? requestPath : "/" + requestPath);
  }
  const target = new URL(requestPath, upstream.origin);
  const headers = { ...request.headers, host: target.host };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("x-dofe-")) delete headers[key];
  }

  const credentialId = process.env.DOFE_AGENT_RUNTIME_CREDENTIAL_ID || "";
  const runtimeId = process.env.DOFE_AGENT_RUNTIME_ID || "";
  const employeeId = process.env.DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID || "";
  const conversationId = process.env.DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID || "";
  if (credentialId && runtimeId && idPattern.test(employeeId) && idPattern.test(conversationId)) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const content = [credentialId, runtimeId, employeeId, conversationId, timestamp].join("\\n");
    headers["x-dofe-employee-id"] = employeeId;
    headers["x-dofe-conversation-id"] = conversationId;
    headers["x-dofe-attribution-timestamp"] = timestamp;
    headers["x-dofe-attribution-signature"] = createHmac("sha256", runtimeKey).update(content, "utf8").digest("hex");
  }

  const transport = target.protocol === "https:" ? https : http;
  const proxyRequest = transport.request(target, { method: request.method, headers }, (proxyResponse) => {
    const requestIdHeader = proxyResponse.headers["x-dofe-request-id"]
      ?? proxyResponse.headers["x-request-id"]
      ?? proxyResponse.headers["request-id"];
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
    const requestLog = process.env.DOFE_AGENT_GATEWAY_REQUEST_LOG;
    if (requestLog && requestId && /^[A-Za-z0-9._:-]{1,256}$/.test(requestId)) {
      appendFileSync(requestLog, JSON.stringify({ requestId }) + "\\n", { encoding: "utf8", mode: 0o600 });
    }
    response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    proxyResponse.pipe(response);
  });
  proxyRequest.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Gateway request failed");
  });
  request.pipe(proxyRequest);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  process.env[baseUrlKey] = "http://127.0.0.1:" + address.port + basePath;
  process.env[runtimeKeyName] = runtimeKey;
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    server.close(() => process.exit(code ?? (signal ? 1 : 0)));
  });
});
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeRuntimeId(value: string): string {
  // Runtime ids include prefixes like "runtime-managed-..." and may contain
  // characters that are safe for filesystem names but not for arbitrary nesting.
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
