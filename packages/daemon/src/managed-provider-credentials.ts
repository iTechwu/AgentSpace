import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
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
  hermes: "/opt/hermes/.venv/bin/hermes-agent",
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
  "DOFE_AGENT_GATEWAY_PROTOCOL",
  "DOFE_AGENT_MANAGED_PROXY_HEALTHCHECK",
  "DOFE_AGENT_GATEWAY_HEALTHCHECK_PATH",
] as const;

const ATTRIBUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MANAGED_RUNTIME_TLS_CA_CONTAINER_PATH = "/run/dofe-agent-runtime-ca.pem";
const MANAGED_RUNTIME_EXTRA_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:(?:host-gateway|(?:\d{1,3}\.){3}\d{1,3})$/;

export interface ManagedGatewayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
}

const MANAGED_GATEWAY_USAGE_EXTRACTOR_SOURCE = String.raw`
function extractGatewayUsage(value) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  const inputKeys = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "promptTokenCount"];
  const outputKeys = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "candidatesTokenCount"];
  const cacheKeys = ["cached_tokens", "cache_tokens", "cacheTokens", "cachedInputTokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

  function readToken(record, keys) {
    for (const key of keys) {
      const token = record[key];
      if (typeof token === "number" && Number.isFinite(token) && token >= 0) return token;
    }
    return 0;
  }

  function readCacheTokens(record) {
    const aliased = readToken(record, ["cached_tokens", "cache_tokens", "cacheTokens", "cachedInputTokens"]);
    const anthropic = readToken(record, ["cache_read_input_tokens"])
      + readToken(record, ["cache_creation_input_tokens"]);
    return Math.max(aliased, anthropic);
  }

  function visit(current, parentKey) {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, parentKey);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current;
    const hasInput = inputKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
    const hasOutput = outputKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
    const hasCache = cacheKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
    const isUsageObject = /usage/i.test(parentKey || "") || (hasInput && hasOutput);
    if (isUsageObject) {
      inputTokens = Math.max(inputTokens, readToken(record, inputKeys));
      outputTokens = Math.max(outputTokens, readToken(record, outputKeys));
    }
    if (isUsageObject || hasCache) cacheTokens = Math.max(cacheTokens, readCacheTokens(record));
    for (const [key, nested] of Object.entries(record)) visit(nested, key);
  }

  visit(value, "");
  return inputTokens > 0 || outputTokens > 0
    ? { inputTokens, outputTokens, ...(cacheTokens > 0 ? { cacheTokens } : {}) }
    : undefined;
}`;

let managedGatewayUsageExtractor: ((value: unknown) => ManagedGatewayUsage | undefined) | undefined;

export function extractManagedGatewayUsage(value: unknown): ManagedGatewayUsage | undefined {
  managedGatewayUsageExtractor ??= Function(
    `"use strict"; ${MANAGED_GATEWAY_USAGE_EXTRACTOR_SOURCE}; return extractGatewayUsage;`,
  )() as (input: unknown) => ManagedGatewayUsage | undefined;
  return managedGatewayUsageExtractor(value);
}

export function buildManagedRuntimeAttributionHeaders(input: {
  runtimeKey: string;
  runtimeCredentialId: string;
  runtimeId: string;
  employeeId: string;
  conversationId: string;
  timestampSeconds: number;
}): Record<string, string> {
  const employeeId = encodeAttributionIdentifier(input.employeeId);
  const conversationId = encodeAttributionIdentifier(input.conversationId);
  if (!employeeId || !conversationId) {
    throw new Error("managed_runtime.invalid_attribution_id");
  }
  const timestamp = String(input.timestampSeconds);
  const content = [input.runtimeCredentialId, input.runtimeId, employeeId, conversationId, timestamp].join("\n");
  return {
    "x-dofe-runtime-credential-id": input.runtimeCredentialId,
    "x-dofe-runtime-id": input.runtimeId,
    "x-dofe-employee-id": employeeId,
    "x-dofe-conversation-id": conversationId,
    "x-dofe-attribution-timestamp": timestamp,
    "x-dofe-attribution-signature": createHmac("sha256", input.runtimeKey).update(content, "utf8").digest("hex"),
  };
}

function encodeAttributionIdentifier(value: string): string | undefined {
  if (ATTRIBUTION_ID_PATTERN.test(value)) return value;
  const encoded = `utf8.${Buffer.from(value, "utf8").toString("base64url")}`;
  return ATTRIBUTION_ID_PATTERN.test(encoded) ? encoded : undefined;
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
  const dockerNetwork = resolveManagedRuntimeDockerNetwork();
  const connectivityArgs = buildManagedRuntimeDockerConnectivityArgs()
    .map((argument) => `  ${shellQuote(argument)} \\\n`)
    .join("");
  const environmentArgs = [PROVIDER_BASE_URL_KEYS[provider], ...ATTRIBUTION_ENVIRONMENT_KEYS]
    .map((key) => `  --env ${key} \\\n`)
    .join("");
  return [
    "#!/bin/sh",
    "set -eu",
    "exec docker run --rm --init \\",
    "  --pull never \\",
    "  --read-only \\",
    "  --tmpfs /tmp:rw,nosuid,nodev,noexec \\",
    "  --security-opt no-new-privileges \\",
    "  --cap-drop ALL \\",
    connectivityArgs.trimEnd(),
    `  --network ${shellQuote(dockerNetwork)} \\`,
    "  --user \"$(id -u):$(id -g)\" \\",
    `  --name ${shellQuote(`dofe-runtime-${normalizeRuntimeId(runtimeId)}`)} \\`,
    "  --mount type=bind,src=$(pwd),dst=/workspace \\",
    `  --mount ${shellQuote(`type=bind,src=${profileDir},dst=/dofe-profile,readonly`)} \\`,
    `  --mount ${shellQuote(`type=bind,src=${runtimeHomeDir},dst=/dofe-home`)} \\`,
    "  --workdir /workspace \\",
    "  --env HOME=/dofe-home \\",
    "  --entrypoint node \\",
    environmentArgs.trimEnd(),
    `  ${shellQuote(image)} /dofe-profile/attribution-proxy.mjs ${shellQuote(PROVIDER_BASE_URL_KEYS[provider])} ${shellQuote(getManagedProviderCredentialEnvironmentKey(provider))} /dofe-profile/runtime-key ${shellQuote(PROVIDER_EXECUTABLES[provider])} \"$@\"`,
    "",
  ].join("\n");
}

export function resolveManagedRuntimeDockerNetwork(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const network = environment.MANAGED_RUNTIME_DOCKER_NETWORK?.trim();
  if (!network) throw new Error("managed_runtime.docker_network_required");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(network)) {
    throw new Error("managed_runtime.docker_network_invalid");
  }
  if (["bridge", "default", "host", "none"].includes(network.toLowerCase())) {
    throw new Error("managed_runtime.docker_network_not_isolated");
  }
  return network;
}

export function buildManagedRuntimeDockerConnectivityArgs(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const extraHosts = (environment.MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (extraHosts.length > 16 || new Set(extraHosts).size !== extraHosts.length) {
    throw new Error("managed_runtime.docker_extra_hosts_invalid");
  }
  for (const extraHost of extraHosts) {
    if (!MANAGED_RUNTIME_EXTRA_HOST_PATTERN.test(extraHost)) {
      throw new Error("managed_runtime.docker_extra_hosts_invalid");
    }
  }

  const args = extraHosts.flatMap((extraHost) => ["--add-host", extraHost]);
  const tlsCaPath = environment.MANAGED_RUNTIME_TLS_CA_PATH?.trim();
  if (!tlsCaPath) return args;
  if (!isAbsolute(tlsCaPath) || tlsCaPath.includes("\0")) {
    throw new Error("managed_runtime.tls_ca_path_invalid");
  }
  return [
    ...args,
    "--mount", `type=bind,src=${tlsCaPath},dst=${MANAGED_RUNTIME_TLS_CA_CONTAINER_PATH},readonly`,
    "--env", `NODE_EXTRA_CA_CERTS=${MANAGED_RUNTIME_TLS_CA_CONTAINER_PATH}`,
  ];
}

function buildAttributionProxySource(): string {
  return `import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";

${MANAGED_GATEWAY_USAGE_EXTRACTOR_SOURCE}

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
const encodeAttributionId = (value) => {
  if (idPattern.test(value)) return value;
  const encoded = "utf8." + Buffer.from(value, "utf8").toString("base64url");
  return idPattern.test(encoded) ? encoded : "";
};
const server = http.createServer((request, response) => {
  const requestStartedAt = new Date().toISOString();
  let requestPath = request.url || "/";
  if (basePath && requestPath !== basePath && !requestPath.startsWith(basePath + "/")) {
    requestPath = basePath + (requestPath.startsWith("/") ? requestPath : "/" + requestPath);
  }
  const target = new URL(requestPath, upstream.origin);
  const headers = { ...request.headers, host: target.host };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("x-dofe-")) delete headers[key];
  }
  // The CLI is not a trusted credential boundary. In particular, Codex's
  // custom Responses provider does not send OPENAI_API_KEY at all, so always
  // replace its auth headers with the runtime-scoped gateway credential.
  headers.authorization = "Bearer " + runtimeKey;
  headers["x-api-key"] = runtimeKey;
  headers["x-goog-api-key"] = runtimeKey;
  headers["accept-encoding"] = "identity";

  const credentialId = process.env.DOFE_AGENT_RUNTIME_CREDENTIAL_ID || "";
  const runtimeId = process.env.DOFE_AGENT_RUNTIME_ID || "";
  const employeeId = encodeAttributionId(process.env.DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID || "");
  const conversationId = encodeAttributionId(process.env.DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID || "");
  if (credentialId && runtimeId && idPattern.test(employeeId) && idPattern.test(conversationId)) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const content = [credentialId, runtimeId, employeeId, conversationId, timestamp].join("\\n");
    headers["x-dofe-runtime-credential-id"] = credentialId;
    headers["x-dofe-runtime-id"] = runtimeId;
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
    const usageIdHeader = proxyResponse.headers["x-dofe-usage-id"] ?? proxyResponse.headers["x-usage-id"];
    const gatewayUsageId = Array.isArray(usageIdHeader) ? usageIdHeader[0] : usageIdHeader;
    const requestLog = process.env.DOFE_AGENT_GATEWAY_REQUEST_LOG;
    response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
    let responseBody = "";
    let responseBodyTooLarge = false;
    let pendingLine = "";
    let capturedUsage;
    const decoder = new StringDecoder("utf8");
    const captureUsage = (value) => {
      const usage = extractGatewayUsage(value);
      if (!usage) return;
      capturedUsage = {
        inputTokens: Math.max(capturedUsage?.inputTokens || 0, usage.inputTokens),
        outputTokens: Math.max(capturedUsage?.outputTokens || 0, usage.outputTokens),
        cacheTokens: Math.max(capturedUsage?.cacheTokens || 0, usage.cacheTokens || 0),
      };
    };
    const captureEventLine = (line) => {
      const candidate = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!candidate || candidate === "[DONE]") return;
      try { captureUsage(JSON.parse(candidate)); } catch {}
    };
    proxyResponse.on("data", (chunk) => {
      const text = decoder.write(chunk);
      if (!responseBodyTooLarge) {
        if (responseBody.length + text.length <= 8 * 1024 * 1024) responseBody += text;
        else responseBodyTooLarge = true;
      }
      pendingLine += text;
      const lines = pendingLine.split(/\\r?\\n/);
      pendingLine = lines.pop() || "";
      for (const line of lines) captureEventLine(line);
      response.write(chunk);
    });
    proxyResponse.on("end", () => {
      const finalText = decoder.end();
      pendingLine += finalText;
      if (!responseBodyTooLarge) responseBody += finalText;
      captureEventLine(pendingLine);
      if (!responseBodyTooLarge) {
        try { captureUsage(JSON.parse(responseBody)); } catch {}
      }
      const statusCode = proxyResponse.statusCode || 502;
      if (
        requestLog && requestId && /^[A-Za-z0-9._:-]{1,256}$/.test(requestId)
        && statusCode >= 200 && statusCode < 300 && capturedUsage
      ) {
    appendFileSync(requestLog, JSON.stringify({
      requestId,
      gatewayUsageId: typeof gatewayUsageId === "string" ? gatewayUsageId : undefined,
      protocol: process.env.DOFE_AGENT_GATEWAY_PROTOCOL || undefined,
      requestStartedAt,
      requestEndedAt: new Date().toISOString(),
      ...capturedUsage,
    }) + "\\n", { encoding: "utf8", mode: 0o600 });
      }
      response.end();
    });
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
  const localBaseUrl = "http://127.0.0.1:" + address.port + basePath;
  process.env[baseUrlKey] = localBaseUrl;
  process.env[runtimeKeyName] = runtimeKey;
  if (process.env.DOFE_AGENT_MANAGED_PROXY_HEALTHCHECK === "1") {
    const healthPath = process.env.DOFE_AGENT_GATEWAY_HEALTHCHECK_PATH || "/models";
    const headers = {
      authorization: "Bearer " + runtimeKey,
      "x-api-key": runtimeKey,
      "x-goog-api-key": runtimeKey,
    };
    fetch(localBaseUrl + healthPath, { headers }).then(async (response) => {
      await response.arrayBuffer();
      if (!response.ok) throw new Error("gateway_http_" + response.status);
      server.close(() => process.exit(0));
    }).catch((error) => {
      console.error(error.message);
      server.close(() => process.exit(1));
    });
    return;
  }
  // Codex 0.144 ignores OPENAI_BASE_URL for its Responses WebSocket client.
  // Its native model_provider configuration is the supported way to route
  // Responses traffic, so point it at this local attribution proxy.
  const providerArgs = executable === "codex" && baseUrlKey === "OPENAI_BASE_URL"
    ? [
      "-c", "model_provider=\\\"dofe-managed\\\"",
      "-c", "model_providers.dofe-managed.name=\\\"Dofe managed gateway\\\"",
      "-c", "model_providers.dofe-managed.base_url=" + JSON.stringify(localBaseUrl),
      "-c", "model_providers.dofe-managed.wire_api=\\\"responses\\\"",
      "-c", "model_providers.dofe-managed.requires_openai_auth=true",
      ...args,
    ]
    : args;
  const child = spawn(executable, providerArgs, { stdio: "inherit", env: process.env });
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
