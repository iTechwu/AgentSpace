import assert from "node:assert/strict";
import test from "node:test";
import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { signMcpEgressLease } from "@dofe-agent/services";
import { McpEgressPolicyCache } from "./policy-cache.ts";
import { McpEgressProxyServer } from "./server.ts";

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
    authMode: "none",
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 1_048_576,
    maxConcurrentStreams: 8,
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

function buildSnapshot(policy: McpEgressPolicyRevision): McpEgressPolicySnapshot {
  return { revision: policy, revoked: false, fetchedAt: new Date().toISOString() };
}

function buildLeaseToken(overrides: Partial<{ exp: number; purpose: "verify" | "health_check" | "task_call" }> = {}): string {
  const exp = overrides.exp ?? Math.floor(Date.now() / 1000) + 60;
  const purpose = overrides.purpose ?? "task_call";
  return signMcpEgressLease(
    {
      iss: "agentspace-control-plane",
      aud: "mcp-egress-proxy",
      jti: `jti-${Date.now()}`,
      workspaceId: "ws-1",
      runtimeId: "rt-1",
      connectionId: "conn-1",
      releaseId: "rel-1",
      policyRevisionId: "pol-1",
      purpose,
      taskId: "task-1",
      toolName: "some_tool",
      exp,
    },
    SECRET,
  );
}

test("healthz returns ok without lease", async () => {
  const cache = new McpEgressPolicyCache();
  const auditRecords: unknown[] = [];
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: { leaseSecret: SECRET, fetchPolicySnapshot: (id) => cache.get(id) },
    auditSink: { record: (r) => auditRecords.push(r) },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  } finally {
    await close();
  }
});

test("request without lease returns 401", async () => {
  const cache = new McpEgressPolicyCache();
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: { leaseSecret: SECRET, fetchPolicySnapshot: (id) => cache.get(id) },
    auditSink: { record: () => undefined },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/v1/mcp/sessions`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("request with invalid lease returns 403", async () => {
  const cache = new McpEgressPolicyCache();
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: { leaseSecret: SECRET, fetchPolicySnapshot: (id) => cache.get(id) },
    auditSink: { record: () => undefined },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/v1/mcp/sessions`, {
      headers: { authorization: "DofeEgressLease invalid-token" },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("request with valid lease but unknown policy returns policy_mismatch", async () => {
  const cache = new McpEgressPolicyCache();
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: { leaseSecret: SECRET, fetchPolicySnapshot: (id) => cache.get(id) },
    auditSink: { record: () => undefined },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/v1/mcp/sessions`, {
      method: "POST",
      headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "mcp_egress.policy_mismatch");
  } finally {
    await close();
  }
});

test("request with valid lease and policy but disallowed path returns policy_denied", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot(basePolicy()));
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: { leaseSecret: SECRET, fetchPolicySnapshot: (id) => cache.get(id) },
    auditSink: { record: () => undefined },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/v1/mcp/sessions`, {
      method: "POST",
      headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "mcp_egress.policy_denied");
  } finally {
    await close();
  }
});
