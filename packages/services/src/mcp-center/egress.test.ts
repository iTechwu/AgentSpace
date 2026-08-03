import assert from "node:assert/strict";
import test from "node:test";
import type { McpEgressLeaseClaims, McpEgressPolicyRevision } from "@dofe-agent/domain";
import {
  canonicalizeMcpEgressPolicyRevision,
  digestMcpEgressPolicyRevision,
  hashMcpEgressAuditValue,
  isMcpEgressLeaseExpired,
  signMcpEgressLease,
  verifyMcpEgressLease,
} from "./egress.ts";

const SECRET = "a".repeat(32);

function basePolicy(): McpEgressPolicyRevision {
  return {
    id: "pol-1",
    workspaceId: "ws-1",
    connectionId: "conn-1",
    releaseId: "rel-1",
    manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    upstream: {
      origin: "https://github-mcp.example.com",
      allowedHosts: ["github-mcp.example.com"],
      allowedPorts: [443],
      allowedPathPrefix: "/mcp",
    },
    transport: "streamable_http",
    redirectPolicy: "deny",
    denyPrivateNetworks: true,
    tlsMode: "verify_system",
    authMode: "static_header",
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 1_048_576,
    maxConcurrentStreams: 8,
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

function baseClaims(exp: number): McpEgressLeaseClaims {
  return {
    iss: "agentspace-control-plane",
    aud: "mcp-egress-proxy",
    jti: "jti-1",
    workspaceId: "ws-1",
    runtimeId: "rt-1",
    connectionId: "conn-1",
    releaseId: "rel-1",
    policyRevisionId: "pol-1",
    purpose: "task_call",
    taskId: "task-1",
    toolName: "some_tool",
    exp,
  };
}

test("canonicalizeMcpEgressPolicyRevision is stable across field reordering", () => {
  const a = basePolicy();
  const b = { ...a, upstream: { ...a.upstream, allowedHosts: ["github-mcp.example.com"] } };
  assert.equal(canonicalizeMcpEgressPolicyRevision(a), canonicalizeMcpEgressPolicyRevision(b));

  const c = { ...a, upstream: { ...a.upstream, allowedHosts: ["z.example.com", "github-mcp.example.com"] } };
  const d = { ...a, upstream: { ...a.upstream, allowedHosts: ["github-mcp.example.com", "z.example.com"] } };
  assert.equal(canonicalizeMcpEgressPolicyRevision(c), canonicalizeMcpEgressPolicyRevision(d));
});

test("canonicalizeMcpEgressPolicyRevision excludes manifestDigest from the canonical form", () => {
  const a = basePolicy();
  const b = { ...a, manifestDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" };
  assert.equal(canonicalizeMcpEgressPolicyRevision(a), canonicalizeMcpEgressPolicyRevision(b));
});

test("digestMcpEgressPolicyRevision returns a stable sha256 prefix independent of manifestDigest", () => {
  const digest = digestMcpEgressPolicyRevision(basePolicy());
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(digestMcpEgressPolicyRevision(basePolicy()), digest);

  const withDifferentManifest = {
    ...basePolicy(),
    manifestDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  };
  assert.equal(digestMcpEgressPolicyRevision(withDifferentManifest), digest);
});

test("signMcpEgressLease produces a three-part token", () => {
  const token = signMcpEgressLease(baseClaims(Math.floor(Date.now() / 1000) + 60), SECRET);
  assert.equal(token.split(".").length, 3);
});

test("verifyMcpEgressLease accepts a valid lease", () => {
  const claims = baseClaims(Math.floor(Date.now() / 1000) + 60);
  const token = signMcpEgressLease(claims, SECRET);
  const result = verifyMcpEgressLease(token, SECRET);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lease.jti, claims.jti);
  assert.equal(result.lease.claims.connectionId, claims.connectionId);
});

test("verifyMcpEgressLease rejects a token signed with a different secret", () => {
  const claims = baseClaims(Math.floor(Date.now() / 1000) + 60);
  const token = signMcpEgressLease(claims, SECRET);
  const result = verifyMcpEgressLease(token, "b".repeat(32));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("verifyMcpEgressLease rejects an expired lease", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = baseClaims(now - 120);
  const token = signMcpEgressLease(claims, SECRET);
  const result = verifyMcpEgressLease(token, SECRET, { nowSeconds: now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_expired");
});

test("verifyMcpEgressLease rejects a lease at its exact expiration", () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signMcpEgressLease(baseClaims(now), SECRET);
  const result = verifyMcpEgressLease(token, SECRET, { nowSeconds: now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_expired");
});

test("verifyMcpEgressLease rejects purpose TTL escalation", () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signMcpEgressLease(baseClaims(now + 61), SECRET);
  const result = verifyMcpEgressLease(token, SECRET, { nowSeconds: now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("verifyMcpEgressLease rejects signed tokens with incomplete binding claims", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...baseClaims(now + 60), workspaceId: "" };
  const token = signMcpEgressLease(claims, SECRET);
  const result = verifyMcpEgressLease(token, SECRET, { nowSeconds: now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("verifyMcpEgressLease requires task-call task and tool binding", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...baseClaims(now + 60), toolName: undefined };
  const token = signMcpEgressLease(claims as McpEgressLeaseClaims, SECRET);
  const result = verifyMcpEgressLease(token, SECRET, { nowSeconds: now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("verifyMcpEgressLease rejects tampered payload", () => {
  const claims = baseClaims(Math.floor(Date.now() / 1000) + 60);
  const token = signMcpEgressLease(claims, SECRET);
  const [header, payload, signature] = token.split(".");
  const payloadObj = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as McpEgressLeaseClaims;
  payloadObj.jti = "jti-2";
  const tamperedPayload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  const result = verifyMcpEgressLease(tampered, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("verifyMcpEgressLease rejects wrong audience", () => {
  const claims = { ...baseClaims(Math.floor(Date.now() / 1000) + 60), aud: "other" as const };
  const token = signMcpEgressLease(claims, SECRET);
  const result = verifyMcpEgressLease(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "mcp_egress.lease_invalid");
});

test("isMcpEgressLeaseExpired is true exactly at exp", () => {
  const claims = baseClaims(1000);
  assert.equal(isMcpEgressLeaseExpired(claims, 999), false);
  assert.equal(isMcpEgressLeaseExpired(claims, 1000), true);
  assert.equal(isMcpEgressLeaseExpired(claims, 1001), true);
});

test("hashMcpEgressAuditValue is stable and one-way", () => {
  const a = hashMcpEgressAuditValue("github-mcp.example.com");
  const b = hashMcpEgressAuditValue("github-mcp.example.com");
  const c = hashMcpEgressAuditValue("other.example.com");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length > 0, true);
});
