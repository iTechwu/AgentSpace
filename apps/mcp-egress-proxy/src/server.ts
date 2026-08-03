import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { buildRejectedAuditRecord, buildUpstreamAuditRecord, type McpEgressAuditSink } from "./audit.ts";
import { verifyLeaseForRequest, type LeaseVerifierDependencies } from "./lease-verifier.ts";
import { OAuthInjector } from "./oauth-injector.ts";
import { McpEgressPolicyCache } from "./policy-cache.ts";
import { forwardToUpstream, type UpstreamRequest } from "./upstream-transport.ts";

const LEASE_HEADER_PREFIX = "DofeEgressLease ";
const ADMIN_AUTH_HEADER = "x-dofe-admin-token";

export interface McpEgressProxyOptions {
  port: number;
  host?: string;
  leaseVerifier: LeaseVerifierDependencies;
  policyCache: McpEgressPolicyCache;
  auditSink: McpEgressAuditSink;
  oauthInjector?: OAuthInjector;
  forwardToUpstream?: typeof forwardToUpstream;
  /** Required to accept POST /v1/admin/policies pushes. */
  adminToken?: string;
}

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const FORBIDDEN_TRUSTED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class McpEgressProxyServer {
  private readonly options: McpEgressProxyOptions;
  private readonly oauthInjector: OAuthInjector;
  private readonly activeStreams = new Map<string, number>();

  constructor(options: McpEgressProxyOptions) {
    this.options = options;
    this.oauthInjector = options.oauthInjector ?? new OAuthInjector();
  }

  async start(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "mcp_egress.internal", message: "Proxy request failed." });
        else res.destroy();
      });
    });
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, host, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return {
      url: `http://${host}:${port}`,
      close: () =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const requestPath = req.url ?? "/";

    if (method === "GET" && requestPath === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && requestPath === "/v1/admin/policies") {
      await this.handlePolicyPush(req, res);
      return;
    }

    if (method === "POST" && requestPath.startsWith("/v1/admin/policies/") && requestPath.endsWith("/revoke")) {
      await this.handlePolicyRevoke(req, res, requestPath);
      return;
    }

    const leaseToken = extractLeaseToken(req);

    const verification = await verifyLeaseForRequest(leaseToken, this.options.leaseVerifier);
    if (!verification.ok) {
      await this.recordRejection(requestPath, method, verification.code);
      sendJson(res, leaseErrorStatus(verification.code), { error: verification.code, message: verification.message });
      return;
    }

    const { claims, policy } = verification;

    if (!this.acquireStream(policy)) {
      await this.recordRejection(requestPath, method, "mcp_egress.policy_denied", claims);
      sendJson(res, 429, { error: "mcp_egress.policy_denied", message: "Policy concurrent stream limit reached." });
      return;
    }

    try {
      await this.forwardVerifiedRequest(req, res, method, requestPath, claims, policy);
    } finally {
      this.releaseStream(policy.id);
    }
  }

  private async handlePolicyPush(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const adminToken = this.options.adminToken;
    if (!adminToken) {
      sendJson(res, 404, { error: "mcp_egress.not_found", message: "Admin policy push is not configured." });
      return;
    }
    const supplied = req.headers[ADMIN_AUTH_HEADER];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    if (value !== adminToken) {
      sendJson(res, 401, { error: "mcp_egress.lease_invalid", message: "Invalid admin token." });
      return;
    }
    const bodyResult = await readRequestBody(req, 256 * 1024);
    if (!bodyResult.ok) {
      sendJson(res, leaseErrorStatus(bodyResult.code), { error: bodyResult.code, message: bodyResult.message });
      return;
    }
    let snapshot: McpEgressPolicySnapshot;
    try {
      snapshot = JSON.parse(bodyResult.body.toString("utf8")) as McpEgressPolicySnapshot;
      if (!snapshot.revision?.id || !snapshot.revision?.upstream?.origin) {
        throw new Error("Invalid policy snapshot.");
      }
    } catch {
      sendJson(res, 400, { error: "mcp_egress.policy_mismatch", message: "Policy snapshot is invalid." });
      return;
    }
    this.options.policyCache.set(snapshot);
    sendJson(res, 200, { accepted: snapshot.revision.id });
  }

  private async handlePolicyRevoke(req: IncomingMessage, res: ServerResponse, requestPath: string): Promise<void> {
    const adminToken = this.options.adminToken;
    if (!adminToken) {
      sendJson(res, 404, { error: "mcp_egress.not_found", message: "Admin policy revoke is not configured." });
      return;
    }
    const supplied = req.headers[ADMIN_AUTH_HEADER];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    if (value !== adminToken) {
      sendJson(res, 401, { error: "mcp_egress.lease_invalid", message: "Invalid admin token." });
      return;
    }
    const prefix = "/v1/admin/policies/";
    const suffix = "/revoke";
    const id = requestPath.slice(prefix.length, requestPath.length - suffix.length);
    if (!id) {
      sendJson(res, 400, { error: "mcp_egress.policy_mismatch", message: "Policy revision id is required." });
      return;
    }
    this.options.policyCache.revoke(id);
    sendJson(res, 200, { revoked: id });
  }

  private async forwardVerifiedRequest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    requestPath: string,
    claims: McpEgressLeaseClaims,
    policy: McpEgressPolicyRevision,
  ): Promise<void> {
    const requestBody = await readRequestBody(req, policy.maxRequestBytes);
    if (!requestBody.ok) {
      await this.recordRejection(requestPath, method, requestBody.code, claims);
      sendJson(res, leaseErrorStatus(requestBody.code), { error: requestBody.code, message: requestBody.message });
      return;
    }

    let upstreamHeaders: Record<string, string>;
    try {
      upstreamHeaders = await this.buildUpstreamHeaders(claims, policy, req);
    } catch {
      await this.recordRejection(requestPath, method, "mcp_egress.policy_denied", claims);
      sendJson(res, 403, { error: "mcp_egress.policy_denied", message: "Upstream authentication policy is unavailable." });
      return;
    }
    const upstreamRequest: UpstreamRequest = {
      method,
      path: requestPath,
      headers: req.headers,
      body: requestBody.body.length > 0 ? bufferToWebStream(requestBody.body) : null,
    };

    const startedAt = Date.now();
    const forward = this.options.forwardToUpstream ?? forwardToUpstream;
    const forwardResult = await forward(policy, claims, upstreamRequest, upstreamHeaders);
    const latencyMs = Date.now() - startedAt;

    if (!forwardResult.ok) {
      await this.recordRejection(requestPath, method, forwardResult.code, claims);
      sendJson(res, leaseErrorStatus(forwardResult.code), { error: forwardResult.code, message: forwardResult.message });
      return;
    }

    const { response, upstreamHost } = forwardResult;
    const declaredResponseLength = parseContentLength(response.headers["content-length"]);
    if (declaredResponseLength !== undefined && declaredResponseLength > policy.maxResponseBytes) {
      await response.body?.cancel("Response byte limit exceeded.");
      await this.recordRejection(requestPath, method, "mcp_egress.response_too_large", claims);
      sendJson(res, leaseErrorStatus("mcp_egress.response_too_large"), {
        error: "mcp_egress.response_too_large",
        message: "Upstream response exceeds the policy byte limit.",
      });
      return;
    }

    res.writeHead(response.statusCode, response.statusMessage, response.headers);
    let responseBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.byteLength;
          if (responseBytes > policy.maxResponseBytes) {
            await reader.cancel("Response byte limit exceeded.");
            const record = buildUpstreamAuditRecord(
              claims,
              upstreamHost,
              method,
              response.statusCode,
              Date.now() - startedAt,
              responseBytes,
              "upstream_failed",
              "mcp_egress.response_too_large",
            );
            await Promise.resolve(this.options.auditSink.record(record)).catch(() => undefined);
            res.destroy();
            return;
          }
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();

    const record = buildUpstreamAuditRecord(claims, upstreamHost, method, response.statusCode, latencyMs, responseBytes, "succeeded");
    await Promise.resolve(this.options.auditSink.record(record)).catch(() => undefined);
  }

  private async buildUpstreamHeaders(
    claims: McpEgressLeaseClaims,
    policy: McpEgressPolicyRevision,
    req: IncomingMessage,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    // The caller controls only MCP protocol headers. Authentication is injected below.
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined) continue;
      if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }

    if (policy.authMode === "static_header") {
      const snapshot = await this.options.leaseVerifier.fetchPolicySnapshot(claims.policyRevisionId);
      if (snapshot?.staticHeaders) {
        for (const [name, value] of Object.entries(snapshot.staticHeaders)) {
          setTrustedHeader(headers, name, value);
        }
      }
    }

    if (policy.authMode === "oauth_proxy") {
      const oauth = await this.oauthInjector.inject(policy.authMode, claims.operationId);
      for (const [name, value] of Object.entries(oauth.headers)) {
        setTrustedHeader(headers, name, value);
      }
    }

    return headers;
  }

  private acquireStream(policy: McpEgressPolicyRevision): boolean {
    const active = this.activeStreams.get(policy.id) ?? 0;
    if (active >= policy.maxConcurrentStreams) return false;
    this.activeStreams.set(policy.id, active + 1);
    return true;
  }

  private releaseStream(policyRevisionId: string): void {
    const active = this.activeStreams.get(policyRevisionId) ?? 0;
    if (active <= 1) this.activeStreams.delete(policyRevisionId);
    else this.activeStreams.set(policyRevisionId, active - 1);
  }

  private async recordRejection(
    requestPath: string,
    method: string,
    code: McpEgressErrorCode,
    claims?: McpEgressLeaseClaims,
  ): Promise<void> {
    const record = buildRejectedAuditRecord(claims, "unknown", method, code);
    await Promise.resolve(this.options.auditSink.record(record)).catch(() => undefined);
  }
}

function extractLeaseToken(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value || !value.startsWith(LEASE_HEADER_PREFIX)) return undefined;
  return value.slice(LEASE_HEADER_PREFIX.length).trim();
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function leaseErrorStatus(code: McpEgressErrorCode): number {
  switch (code) {
    case "mcp_egress.lease_missing":
      return 401;
    case "mcp_egress.lease_expired":
    case "mcp_egress.lease_invalid":
    case "mcp_egress.lease_replayed":
    case "mcp_egress.lease_revoked":
      return 403;
    case "mcp_egress.policy_mismatch":
    case "mcp_egress.policy_denied":
    case "mcp_egress.host_denied":
    case "mcp_egress.port_denied":
    case "mcp_egress.redirect_denied":
    case "mcp_egress.dns_forbidden":
    case "mcp_egress.request_too_large":
      return 403;
    case "mcp_egress.response_too_large":
      return 502;
    case "mcp_egress.tls_failed":
    case "mcp_egress.upstream_failed":
    case "mcp_egress.timeout":
      return 502;
    default:
      return 500;
  }
}

function setTrustedHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) ||
    /[\r\n]/.test(value) ||
    FORBIDDEN_TRUSTED_HEADERS.has(lower) ||
    lower.startsWith("proxy-") ||
    lower.startsWith("x-dofe-")
  ) {
    throw new Error("Trusted authentication policy contains a forbidden header.");
  }
  headers[lower] = value;
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<
  | { ok: true; body: Buffer }
  | { ok: false; code: "mcp_egress.request_too_large"; message: string }
> {
  const declaredLength = parseContentLength(req.headers["content-length"]);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    req.resume();
    return { ok: false, code: "mcp_egress.request_too_large", message: "Request exceeds the policy byte limit." };
  }
  if (req.method === "GET" || req.method === "DELETE") {
    req.resume();
    return { ok: true, body: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      req.resume();
      return { ok: false, code: "mcp_egress.request_too_large", message: "Request exceeds the policy byte limit." };
    }
    chunks.push(buffer);
  }
  return { ok: true, body: Buffer.concat(chunks, bytes) };
}

function bufferToWebStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([buffer])) as ReadableStream<Uint8Array>;
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
