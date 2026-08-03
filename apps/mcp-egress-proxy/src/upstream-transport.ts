import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision } from "@dofe-agent/domain";
import { digestMcpPrivateCa } from "@dofe-agent/services/mcp-center/egress";
import { validateMcpEndpoint, validateMcpResolvedAddresses } from "@dofe-agent/services/mcp-center/security";

const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);
const MCP_CONTENT_TYPES = new Set([
  "application/json",
  "text/event-stream",
]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface UpstreamRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: ReadableStream<Uint8Array> | null;
}

export interface UpstreamResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: ReadableStream<Uint8Array> | null;
}

export interface UpstreamTransportResult {
  ok: true;
  response: UpstreamResponse;
  upstreamHost: string;
}

export interface UpstreamTransportFailure {
  ok: false;
  code: McpEgressErrorCode;
  message: string;
}

export interface UpstreamTransportOptions {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  privateCaPem?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function reject(code: McpEgressErrorCode, message: string): UpstreamTransportFailure {
  return { ok: false, code, message };
}

/**
 * Validates that the request conforms to the policy and MCP Streamable HTTP
 * transport restrictions, then opens a pinned TLS connection to the upstream.
 */
export async function forwardToUpstream(
  policy: McpEgressPolicyRevision,
  _claims: McpEgressLeaseClaims,
  request: UpstreamRequest,
  upstreamHeaders: Record<string, string>,
  options: UpstreamTransportOptions = {},
): Promise<UpstreamTransportResult | UpstreamTransportFailure> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return reject("mcp_egress.policy_denied", `Method ${request.method} is not allowed.`);
  }

  const path = normalizeAllowedPath(request.path, policy.upstream.allowedPathPrefix);
  if (path === undefined) {
    return reject("mcp_egress.policy_denied", "Request path is outside the allowed prefix.");
  }

  const endpointValidation = validateMcpEndpoint(policy.upstream.origin, policy.upstream.allowedHosts);
  if (!endpointValidation.ok || !endpointValidation.host) {
    return reject(
      endpointValidation.code === "mcp.network_unreachable" ? "mcp_egress.upstream_failed" : "mcp_egress.policy_denied",
      endpointValidation.message ?? "Upstream origin is invalid.",
    );
  }
  const upstreamHost = endpointValidation.host;
  const upstreamUrl = new URL(path, policy.upstream.origin);
  const upstreamPort = upstreamUrl.port ? Number(upstreamUrl.port) : 443;
  if (!policy.upstream.allowedPorts.includes(upstreamPort as 443)) {
    return reject("mcp_egress.port_denied", "Upstream port is outside the policy allow-list.");
  }

  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (request.method === "POST" && !isAllowedMcpContentType(contentType)) {
    return reject("mcp_egress.policy_denied", "Content-Type is not allowed for MCP Streamable HTTP.");
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const privateCaPem = options.privateCaPem?.trim();
  if (policy.tlsMode === "verify_private_ca") {
    if (!privateCaPem || !policy.privateCaDigest || digestMcpPrivateCa(privateCaPem) !== policy.privateCaDigest) {
      return reject("mcp_egress.tls_failed", "Private CA material does not match the policy.");
    }
  } else if (policy.privateCaDigest || privateCaPem) {
    return reject("mcp_egress.tls_failed", "Private CA material is not allowed by the policy.");
  }

  try {
    const resolved = await lookup(upstreamHost, { all: true, verbatim: true });
    const addresses = resolved.map((entry) => entry.address);
    const addressValidation = validateMcpResolvedAddresses(addresses);
    if (!addressValidation.ok) {
      return reject(
        addressValidation.code === "mcp.network_unreachable" ? "mcp_egress.upstream_failed" : "mcp_egress.dns_forbidden",
        addressValidation.message ?? "Upstream DNS resolution was rejected.",
      );
    }
    const pinnedAddress = addresses[0]!;

    const response = await pinnedHttpsRequest({
      upstreamHost,
      pinnedAddress,
      method: request.method,
      path: upstreamUrl.pathname,
      headers: upstreamHeaders,
      body: request.body,
      connectTimeoutMs,
      requestTimeoutMs,
      idleTimeoutMs,
      ca: privateCaPem,
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      await response.body?.cancel("Redirects are forbidden by MCP egress policy.");
      return reject("mcp_egress.redirect_denied", "Upstream redirects are not allowed.");
    }
    return { ok: true, response, upstreamHost };
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.includes("timeout") || message.includes("ETIMEDOUT")) {
      return reject("mcp_egress.timeout", "Upstream request timed out.");
    }
    if (/certificate|tls|ssl|self signed/i.test(message)) {
      return reject("mcp_egress.tls_failed", "Upstream TLS verification failed.");
    }
    return reject("mcp_egress.upstream_failed", "Upstream request failed.");
  }
}

export function normalizeAllowedPath(requestPath: string, prefix: string): string | undefined {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//") || requestPath.includes("?") || requestPath.includes("#")) {
    return undefined;
  }
  let pathname: string;
  try {
    pathname = new URL(requestPath, "https://proxy.invalid").pathname;
  } catch {
    return undefined;
  }
  const normalizedPrefix = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (normalizedPrefix === "/") return pathname;
  if (pathname !== normalizedPrefix && !pathname.startsWith(`${normalizedPrefix}/`)) return undefined;
  return pathname;
}

export function isAllowedMcpContentType(value: string): boolean {
  const [mediaType] = value.split(";", 1);
  return MCP_CONTENT_TYPES.has(mediaType?.trim().toLowerCase() ?? "");
}

interface PinnedHttpsRequestInput {
  upstreamHost: string;
  pinnedAddress: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  ca?: string;
}

function pinnedHttpsRequest(input: PinnedHttpsRequestInput): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.upstreamHost,
      port: 443,
      path: input.path,
      method: input.method,
      headers: input.headers,
      servername: input.upstreamHost,
      ...(input.ca ? { ca: input.ca } : {}),
      lookup: (_hostname, _options, callback) => callback(null, input.pinnedAddress, isIPv4(input.pinnedAddress) ? 4 : 6),
    }, (response) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || lower === "set-cookie") continue;
        headers[lower] = Array.isArray(value) ? value : String(value);
      }
      resolve({
        statusCode: response.statusCode ?? 502,
        statusMessage: response.statusMessage ?? "",
        headers,
        body: response ? (Readable.toWeb(response) as ReadableStream<Uint8Array>) : null,
      });
    });

    const connectTimer = setTimeout(() => request.destroy(new Error("Connection timeout.")), input.connectTimeoutMs);
    const requestTimer = setTimeout(() => request.destroy(new Error("Request timeout.")), input.requestTimeoutMs);

    request.once("error", (error) => {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      reject(error);
    });

    request.once("response", () => {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      if (input.idleTimeoutMs > 0) {
        request.setTimeout(input.idleTimeoutMs, () => request.destroy(new Error("Idle timeout.")));
      }
    });

    writeRequestBody(request, input.body).catch((error) => request.destroy(error));
  });
}

async function writeRequestBody(
  request: ReturnType<typeof httpsRequest>,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) {
    request.end();
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      request.write(value);
    }
    request.end();
  } catch (error) {
    request.destroy(error as Error);
  } finally {
    reader.releaseLock();
  }
}

function isIPv4(address: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}
