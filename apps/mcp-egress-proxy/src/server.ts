import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision } from "@dofe-agent/domain";
import { buildRejectedAuditRecord, buildUpstreamAuditRecord, type McpEgressAuditSink } from "./audit.ts";
import { verifyLeaseForRequest, type LeaseVerifierDependencies } from "./lease-verifier.ts";
import { OAuthInjector } from "./oauth-injector.ts";
import { forwardToUpstream, type UpstreamRequest } from "./upstream-transport.ts";

const LEASE_HEADER_PREFIX = "DofeEgressLease ";

export interface McpEgressProxyOptions {
  port: number;
  host?: string;
  leaseVerifier: LeaseVerifierDependencies;
  auditSink: McpEgressAuditSink;
  oauthInjector?: OAuthInjector;
}

export class McpEgressProxyServer {
  private readonly options: McpEgressProxyOptions;
  private readonly oauthInjector: OAuthInjector;

  constructor(options: McpEgressProxyOptions) {
    this.options = options;
    this.oauthInjector = options.oauthInjector ?? new OAuthInjector();
  }

  async start(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => void this.handleRequest(req, res));
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

    const leaseToken = extractLeaseToken(req);

    const verification = await verifyLeaseForRequest(leaseToken, this.options.leaseVerifier);
    if (!verification.ok) {
      await this.recordRejection(requestPath, method, verification.code);
      sendJson(res, leaseErrorStatus(verification.code), { error: verification.code, message: verification.message });
      return;
    }

    const { claims, policy } = verification;

    const upstreamHeaders = await this.buildUpstreamHeaders(claims, policy, req);
    const upstreamRequest: UpstreamRequest = {
      method,
      path: requestPath,
      headers: req.headers,
      body:
        req.method === "GET" || req.method === "DELETE"
          ? null
          : (Readable.toWeb(req) as ReadableStream<Uint8Array>),
    };

    const startedAt = Date.now();
    const forwardResult = await forwardToUpstream(policy, claims, upstreamRequest, upstreamHeaders);
    const latencyMs = Date.now() - startedAt;

    if (!forwardResult.ok) {
      await this.recordRejection(requestPath, method, forwardResult.code, claims);
      sendJson(res, leaseErrorStatus(forwardResult.code), { error: forwardResult.code, message: forwardResult.message });
      return;
    }

    const { response, upstreamHost } = forwardResult;
    res.writeHead(response.statusCode, response.statusMessage, response.headers);
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();

    const record = buildUpstreamAuditRecord(claims, upstreamHost, method, response.statusCode, latencyMs, 0, "succeeded");
    await Promise.resolve(this.options.auditSink.record(record)).catch(() => undefined);
  }

  private async buildUpstreamHeaders(
    claims: McpEgressLeaseClaims,
    policy: McpEgressPolicyRevision,
    req: IncomingMessage,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    // Forward only MCP protocol headers; drop Authorization and any lease header.
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined) continue;
      if (["authorization", "host", "proxy-authorization", "x-forwarded-for"].includes(lower)) continue;
      if (lower.startsWith("x-dofe-")) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }

    if (policy.authMode === "static_header") {
      const snapshot = await this.options.leaseVerifier.fetchPolicySnapshot(claims.policyRevisionId);
      if (snapshot?.staticHeaders) {
        for (const [name, value] of Object.entries(snapshot.staticHeaders)) {
          headers[name] = value;
        }
      }
    }

    if (policy.authMode === "oauth_proxy") {
      const oauth = await this.oauthInjector.inject(policy.authMode, claims.operationId);
      for (const [name, value] of Object.entries(oauth.headers)) {
        headers[name] = value;
      }
    }

    return headers;
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
    case "mcp_egress.tls_failed":
    case "mcp_egress.upstream_failed":
    case "mcp_egress.timeout":
      return 502;
    default:
      return 500;
  }
}
