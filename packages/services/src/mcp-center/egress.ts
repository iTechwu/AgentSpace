import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision } from "@dofe-agent/domain";

const LEASE_VERSION = "deg1";
const LEASE_MAX_TTL_SECONDS = {
  verify: 120,
  health_check: 60,
  task_call: 60,
} as const;

interface DecodedLease {
  header: string;
  payload: string;
  signature: Buffer;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function constantTimeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function signCanonical(input: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(input, "utf8").digest();
}

/**
 * Produces a canonical JSON digest of a policy revision.
 * The digest appears in the policy revision and must be reproduced by the
 * proxy when it loads a snapshot from the control plane.
 */
export function canonicalizeMcpEgressPolicyRevision(policy: McpEgressPolicyRevision): string {
  return JSON.stringify({
    id: policy.id,
    workspaceId: policy.workspaceId,
    connectionId: policy.connectionId,
    releaseId: policy.releaseId,
    manifestDigest: policy.manifestDigest,
    upstream: {
      origin: policy.upstream.origin,
      allowedHosts: [...policy.upstream.allowedHosts].sort(),
      allowedPorts: [...policy.upstream.allowedPorts].sort((a, b) => a - b),
      allowedPathPrefix: policy.upstream.allowedPathPrefix,
    },
    transport: policy.transport,
    redirectPolicy: policy.redirectPolicy,
    denyPrivateNetworks: policy.denyPrivateNetworks,
    tlsMode: policy.tlsMode,
    authMode: policy.authMode,
    maxRequestBytes: policy.maxRequestBytes,
    maxResponseBytes: policy.maxResponseBytes,
    maxConcurrentStreams: policy.maxConcurrentStreams,
    createdAt: policy.createdAt,
  });
}

/**
 * Returns a stable SHA-256 digest of the canonical policy revision.
 * This is the value that appears in `policy.manifestDigest`.
 */
export function digestMcpEgressPolicyRevision(policy: McpEgressPolicyRevision): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalizeMcpEgressPolicyRevision(policy)).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Signs MCP egress lease claims with a control-plane HMAC secret.
 *
 * Phase 0 uses HS256 so tests and local development do not need key
 * management. Production deployments should migrate to RS256/Ed25519 so the
 * proxy can verify with a public key and never hold a signing secret.
 */
export function signMcpEgressLease(claims: McpEgressLeaseClaims, secret: string): string {
  if (!secret || secret.length < 32) {
    throw new Error("MCP egress lease secret must be at least 32 bytes.");
  }
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "DofeEgressLease", ver: LEASE_VERSION }));
  const payload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = signCanonical(signingInput, secret);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function decodeLease(token: string): DecodedLease {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid lease format.");
  }
  const [header, payload, signatureBase64] = parts;
  if (!header || !payload || !signatureBase64) {
    throw new Error("Invalid lease format.");
  }
  return { header, payload, signature: Buffer.from(signatureBase64, "base64url") };
}

export interface VerifiedMcpEgressLease {
  claims: McpEgressLeaseClaims;
  jti: string;
}

export interface McpEgressLeaseVerificationFailure {
  ok: false;
  code: McpEgressErrorCode;
  message: string;
}

/**
 * Verifies the lease signature, version, audience, and expiration.
 * Does NOT check revocation or policy revision presence; the caller must
 * enforce those after verification.
 */
export function verifyMcpEgressLease(
  token: string,
  secret: string,
  options: { nowSeconds?: number; expectedAud?: string } = {},
): { ok: true; lease: VerifiedMcpEgressLease } | McpEgressLeaseVerificationFailure {
  if (!secret || secret.length < 32) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Proxy lease verification secret is not configured." };
  }

  let decoded: DecodedLease;
  try {
    decoded = decodeLease(token);
  } catch {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease is not a valid signed token." };
  }

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(base64urlDecode(decoded.header));
    claims = JSON.parse(base64urlDecode(decoded.payload));
  } catch {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease header or payload is not valid JSON." };
  }

  if (
    !header || typeof header !== "object" ||
    (header as Record<string, unknown>).alg !== "HS256" ||
    (header as Record<string, unknown>).typ !== "DofeEgressLease" ||
    (header as Record<string, unknown>).ver !== LEASE_VERSION
  ) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease header algorithm or version is not supported." };
  }

  const signingInput = `${decoded.header}.${decoded.payload}`;
  const expectedSignature = signCanonical(signingInput, secret);
  if (!constantTimeCompare(expectedSignature, decoded.signature)) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease signature does not match." };
  }

  const parsed = claims as Partial<McpEgressLeaseClaims>;
  const audience = options.expectedAud ?? "mcp-egress-proxy";
  if (parsed.aud !== audience) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease audience is incorrect." };
  }
  if (parsed.iss !== "agentspace-control-plane") {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease issuer is incorrect." };
  }
  const requiredStringClaims = [
    "jti",
    "workspaceId",
    "runtimeId",
    "connectionId",
    "releaseId",
    "policyRevisionId",
  ] as const;
  for (const field of requiredStringClaims) {
    if (typeof parsed[field] !== "string" || parsed[field]!.trim().length === 0) {
      return { ok: false, code: "mcp_egress.lease_invalid", message: `Lease is missing a valid ${field}.` };
    }
  }
  if (!parsed.purpose || !(parsed.purpose in LEASE_MAX_TTL_SECONDS)) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease purpose is invalid." };
  }
  if (parsed.purpose === "task_call") {
    if (typeof parsed.taskId !== "string" || !parsed.taskId.trim() || typeof parsed.toolName !== "string" || !parsed.toolName.trim()) {
      return { ok: false, code: "mcp_egress.lease_invalid", message: "Task-call lease must bind a task and tool." };
    }
  }
  if (!Number.isSafeInteger(parsed.exp) || parsed.exp! <= 0) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease is missing a valid expiration." };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (parsed.exp! <= now) {
    return { ok: false, code: "mcp_egress.lease_expired", message: "Lease has expired." };
  }
  if (parsed.exp! > now + LEASE_MAX_TTL_SECONDS[parsed.purpose]) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease expiration exceeds the allowed purpose TTL." };
  }

  const typedClaims = parsed as McpEgressLeaseClaims;
  return { ok: true, lease: { claims: typedClaims, jti: typedClaims.jti } };
}

/** Returns true when the lease is strictly expired (no skew grace). */
export function isMcpEgressLeaseExpired(claims: McpEgressLeaseClaims, nowSeconds: number): boolean {
  return nowSeconds >= claims.exp;
}

/** One-way hash of an audit-sensitive value (host, JTI, etc). */
export function hashMcpEgressAuditValue(value: string): string {
  return createHmac("sha256", "mcp-egress-audit").update(value).digest("base64url");
}
