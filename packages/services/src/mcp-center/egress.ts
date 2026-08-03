import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision, McpEgressPolicySnapshot, McpEgressPurpose } from "@dofe-agent/domain";

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

export type McpEgressLeaseSigningKey =
  | { algorithm: "EdDSA"; privateKey: string }
  | { algorithm: "HS256"; secret: string };

export type McpEgressLeaseVerificationKey =
  | { algorithm: "EdDSA"; publicKey: string }
  | { algorithm: "HS256"; secret: string };

/**
 * Produces a canonical JSON representation of a policy revision.
 * The digest appears in the policy revision and must be reproduced by the
 * proxy when it loads a snapshot from the control plane.
 *
 * `manifestDigest` is intentionally excluded: it is the output of this
 * canonicalization, so including it would make the digest unstable and
 * impossible to re-derive from the same inputs.
 */
export function canonicalizeMcpEgressPolicyRevision(policy: McpEgressPolicyRevision): string {
  return JSON.stringify({
    id: policy.id,
    workspaceId: policy.workspaceId,
    connectionId: policy.connectionId,
    releaseId: policy.releaseId,
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
 * Signs MCP egress lease claims. String keys retain the Phase 0 HS256 API for
 * explicit migration compatibility; production uses an Ed25519 private key.
 */
export function signMcpEgressLease(claims: McpEgressLeaseClaims, key: string | McpEgressLeaseSigningKey): string {
  const normalizedKey: McpEgressLeaseSigningKey = typeof key === "string"
    ? { algorithm: "HS256", secret: key }
    : key;
  if (normalizedKey.algorithm === "HS256" && normalizedKey.secret.length < 32) {
    throw new Error("MCP egress lease secret must be at least 32 bytes.");
  }
  const header = base64urlEncode(JSON.stringify({
    alg: normalizedKey.algorithm,
    typ: "DofeEgressLease",
    ver: LEASE_VERSION,
  }));
  const payload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = normalizedKey.algorithm === "EdDSA"
    ? signEd25519(signingInput, normalizedKey.privateKey)
    : signCanonical(signingInput, normalizedKey.secret);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function signEd25519(input: string, privateKeyPem: string): Buffer {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("MCP egress lease private key must be Ed25519.");
  }
  return signBytes(null, Buffer.from(input, "utf8"), privateKey);
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
  key: string | McpEgressLeaseVerificationKey,
  options: { nowSeconds?: number; expectedAud?: string } = {},
): { ok: true; lease: VerifiedMcpEgressLease } | McpEgressLeaseVerificationFailure {
  const normalizedKey: McpEgressLeaseVerificationKey = typeof key === "string"
    ? { algorithm: "HS256", secret: key }
    : key;

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

  const headerAlgorithm = header && typeof header === "object"
    ? (header as Record<string, unknown>).alg
    : undefined;
  if (
    !header || typeof header !== "object" ||
    headerAlgorithm !== normalizedKey.algorithm ||
    (header as Record<string, unknown>).typ !== "DofeEgressLease" ||
    (header as Record<string, unknown>).ver !== LEASE_VERSION
  ) {
    return { ok: false, code: "mcp_egress.lease_invalid", message: "Lease header algorithm or version is not supported." };
  }

  const signingInput = `${decoded.header}.${decoded.payload}`;
  let signatureMatches = false;
  try {
    if (normalizedKey.algorithm === "EdDSA") {
      const publicKey = createPublicKey(normalizedKey.publicKey);
      signatureMatches = publicKey.asymmetricKeyType === "ed25519"
        && verifyBytes(null, Buffer.from(signingInput, "utf8"), publicKey, decoded.signature);
    } else if (normalizedKey.secret.length >= 32) {
      signatureMatches = constantTimeCompare(signCanonical(signingInput, normalizedKey.secret), decoded.signature);
    }
  } catch {
    signatureMatches = false;
  }
  if (!signatureMatches) {
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
    "policyDigest",
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
    if (typeof parsed.taskId !== "string" || !parsed.taskId.trim()) {
      return { ok: false, code: "mcp_egress.lease_invalid", message: "Task-call lease must bind a task." };
    }
    if (typeof parsed.toolName !== "string" || !parsed.toolName.trim()) {
      return { ok: false, code: "mcp_egress.lease_invalid", message: "Task-call lease must bind a tool." };
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

const DEFAULT_POLICY_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_POLICY_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_POLICY_MAX_CONCURRENT_STREAMS = 8;

/** Reads the control-plane lease signing secret from the environment. */
export function readMcpEgressLeaseSigningSecret(): string | undefined {
  return process.env.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET?.trim();
}

type PemFileReader = (path: string) => string;

function readAbsolutePemFile(path: string, readFile: PemFileReader): string {
  if (!isAbsolute(path)) {
    throw new Error(`MCP egress lease key file path must be absolute: ${path}`);
  }
  const pem = readFile(path).trim();
  if (!pem) throw new Error(`MCP egress lease key file is empty: ${path}`);
  return pem;
}

/** Control-plane signing config. Ed25519 is preferred; HS256 is migration-only. */
export function readMcpEgressLeaseSigningKey(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: PemFileReader = (path) => readFileSync(path, "utf8"),
): McpEgressLeaseSigningKey | undefined {
  const privateKeyFile = environment.MCP_EGRESS_PROXY_LEASE_SIGNING_PRIVATE_KEY_FILE?.trim();
  if (privateKeyFile) {
    return { algorithm: "EdDSA", privateKey: readAbsolutePemFile(privateKeyFile, readFile) };
  }
  const secret = environment.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET?.trim();
  return secret ? { algorithm: "HS256", secret } : undefined;
}

/** Proxy verification config. Legacy HS256 must be opted into explicitly. */
export function readMcpEgressLeaseVerificationKey(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: PemFileReader = (path) => readFileSync(path, "utf8"),
): McpEgressLeaseVerificationKey | undefined {
  const publicKeyFile = environment.MCP_EGRESS_PROXY_LEASE_VERIFY_PUBLIC_KEY_FILE?.trim();
  if (publicKeyFile) {
    return { algorithm: "EdDSA", publicKey: readAbsolutePemFile(publicKeyFile, readFile) };
  }
  const secret = environment.MCP_EGRESS_PROXY_LEASE_SECRET?.trim();
  return secret && environment.MCP_EGRESS_PROXY_ALLOW_LEGACY_HMAC === "true"
    ? { algorithm: "HS256", secret }
    : undefined;
}

/** Reads the egress proxy admin token from the environment. */
export function readMcpEgressProxyAdminToken(): string | undefined {
  return process.env.MCP_EGRESS_PROXY_ADMIN_TOKEN?.trim();
}

/** Reads the egress proxy base URL from the environment. */
export function readMcpEgressProxyUrl(): string | undefined {
  return process.env.MCP_EGRESS_PROXY_URL?.trim();
}

/**
 * Revokes a policy revision at the egress proxy. Returns true when the proxy
 * acknowledged the revocation. Failures are logged and swallowed: revocation is
 * a best-effort defense-in-depth measure on top of short lease TTLs.
 */
export async function revokeMcpEgressPolicyRevisionAtProxy(policyRevisionId: string): Promise<boolean> {
  const proxyUrl = readMcpEgressProxyUrl();
  const adminToken = readMcpEgressProxyAdminToken();
  if (!proxyUrl || !adminToken) {
    return false;
  }
  try {
    const url = new URL(`/v1/admin/policies/${encodeURIComponent(policyRevisionId)}/revoke`, proxyUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-dofe-admin-token": adminToken,
        "content-type": "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readSigningKeyOrThrow(): McpEgressLeaseSigningKey {
  const key = readMcpEgressLeaseSigningKey();
  if (!key) {
    throw new Error(
      "MCP_EGRESS_PROXY_LEASE_SIGNING_PRIVATE_KEY_FILE is required (legacy: MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET).",
    );
  }
  return key;
}

export interface McpEgressPolicyInput {
  workspaceId: string;
  connectionId: string;
  releaseId: string;
  endpoint: string;
  allowedHosts: string[];
  approvedTools: string[];
  authMode?: "none" | "static_header" | "oauth_proxy";
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrentStreams?: number;
}

/**
 * Builds an immutable policy revision for a connection. The revision id is
 * deterministic so the proxy can re-derive it from the same inputs.
 */
export function buildMcpEgressPolicyRevision(input: McpEgressPolicyInput): McpEgressPolicyRevision {
  const allowedPathPrefix = new URL(input.endpoint).pathname || "/";
  const base: McpEgressPolicyRevision = {
    id: derivePolicyRevisionId(input),
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    releaseId: input.releaseId,
    manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    upstream: {
      origin: normalizeOrigin(input.endpoint),
      allowedHosts: [...input.allowedHosts],
      allowedPorts: [443],
      allowedPathPrefix,
    },
    transport: "streamable_http",
    redirectPolicy: "deny",
    denyPrivateNetworks: true,
    tlsMode: "verify_system",
    authMode: input.authMode ?? "none",
    maxRequestBytes: input.maxRequestBytes ?? DEFAULT_POLICY_MAX_REQUEST_BYTES,
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_POLICY_MAX_RESPONSE_BYTES,
    maxConcurrentStreams: input.maxConcurrentStreams ?? DEFAULT_POLICY_MAX_CONCURRENT_STREAMS,
    createdAt: new Date().toISOString(),
  };
  return { ...base, manifestDigest: digestMcpEgressPolicyRevision(base) };
}

/** Builds the proxy snapshot; authentication material remains outside the immutable digest. */
export function buildMcpEgressPolicySnapshot(
  revision: McpEgressPolicyRevision,
  secrets: Record<string, string>,
  fetchedAt = new Date().toISOString(),
): McpEgressPolicySnapshot {
  const staticHeaders = revision.authMode === "static_header"
    ? Object.fromEntries(Object.entries(secrets).filter(([, value]) => typeof value === "string" && value.length > 0))
    : undefined;
  return {
    revision,
    revoked: false,
    fetchedAt,
    ...(staticHeaders && Object.keys(staticHeaders).length > 0 ? { staticHeaders } : {}),
  };
}

function normalizeOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

function derivePolicyRevisionId(input: McpEgressPolicyInput): string {
  const allowedPathPrefix = new URL(input.endpoint).pathname || "/";
  const hash = createHash("sha256")
    .update(input.workspaceId)
    .update("|")
    .update(input.connectionId)
    .update("|")
    .update(input.releaseId)
    .update("|")
    .update(normalizeOrigin(input.endpoint))
    .update("|")
    .update(allowedPathPrefix)
    .update("|")
    .update([...input.allowedHosts].sort().join(","))
    .update("|")
    .update([...input.approvedTools].sort().join(","))
    .update("|")
    .update("streamable_http")
    .update("|")
    .update("deny")
    .update("|")
    .update(String(true))
    .update("|")
    .update("verify_system")
    .update("|")
    .update(input.authMode ?? "none")
    .update("|")
    .update(String(input.maxRequestBytes ?? DEFAULT_POLICY_MAX_REQUEST_BYTES))
    .update("|")
    .update(String(input.maxResponseBytes ?? DEFAULT_POLICY_MAX_RESPONSE_BYTES))
    .update("|")
    .update(String(input.maxConcurrentStreams ?? DEFAULT_POLICY_MAX_CONCURRENT_STREAMS))
    .digest("hex");
  return `pol-${hash.slice(0, 32)}`;
}

function createLeaseClaims(
  policy: McpEgressPolicyRevision,
  purpose: McpEgressPurpose,
  runtimeId: string,
  overrides: { taskId?: string; toolName?: string; operationId?: string },
): McpEgressLeaseClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "agentspace-control-plane",
    aud: "mcp-egress-proxy",
    jti: `${policy.connectionId}:${purpose}:${now}:${cryptoRandomHex(8)}`,
    workspaceId: policy.workspaceId,
    runtimeId,
    connectionId: policy.connectionId,
    releaseId: policy.releaseId,
    policyRevisionId: policy.id,
    policyDigest: policy.manifestDigest,
    purpose,
    taskId: overrides.taskId,
    operationId: overrides.operationId,
    toolName: overrides.toolName,
    exp: now + LEASE_MAX_TTL_SECONDS[purpose],
  };
}

function cryptoRandomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Signs a lease for an MCP connection verify/health_check operation. */
export function signMcpEgressLeaseForOperation(
  input: McpEgressPolicyInput & { runtimeId: string; operationId: string; purpose: "verify" | "health_check" },
): string {
  const policy = buildMcpEgressPolicyRevision(input);
  const claims = createLeaseClaims(policy, input.purpose, input.runtimeId, { operationId: input.operationId });
  return signMcpEgressLease(claims, readSigningKeyOrThrow());
}

/** Signs a lease for a task-scoped MCP tool call. */
export function signMcpEgressLeaseForTaskCall(
  input: McpEgressPolicyInput & { runtimeId: string; taskId: string; toolName: string },
): string {
  const policy = buildMcpEgressPolicyRevision(input);
  const claims = createLeaseClaims(policy, "task_call", input.runtimeId, { taskId: input.taskId, toolName: input.toolName });
  return signMcpEgressLease(claims, readSigningKeyOrThrow());
}
