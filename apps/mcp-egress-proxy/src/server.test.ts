import assert from "node:assert/strict";
import test from "node:test";
import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { digestMcpEgressPolicyRevision, signMcpEgressLease } from "@dofe-agent/services";
import { McpEgressPolicyCache } from "./policy-cache.ts";
import { McpEgressProxyServer } from "./server.ts";
import { InMemoryJtiReplayGuard } from "./jti-replay-guard.ts";

const SECRET = "a".repeat(32);
let leaseSequence = 0;

function basePolicy(): McpEgressPolicyRevision {
  const policy: McpEgressPolicyRevision = {
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
  return { ...policy, manifestDigest: digestMcpEgressPolicyRevision(policy) };
}

function buildSnapshot(policy: McpEgressPolicyRevision): McpEgressPolicySnapshot {
  return { revision: policy, revoked: false, fetchedAt: new Date().toISOString() };
}

function buildLeaseVerifier(cache: McpEgressPolicyCache) {
  const guard = new InMemoryJtiReplayGuard();
  return {
    leaseSecret: SECRET,
    fetchPolicySnapshot: (id: string) => cache.get(id),
    bindJtiToSession: (jti: string, sessionId: string | undefined, exp: number) => guard.bind(jti, sessionId, exp),
  };
}

function buildLeaseToken(overrides: Partial<{ exp: number; purpose: "verify" | "health_check" | "task_call" }> = {}): string {
  const exp = overrides.exp ?? Math.floor(Date.now() / 1000) + 60;
  const purpose = overrides.purpose ?? "task_call";
  return signMcpEgressLease(
    {
      iss: "agentspace-control-plane",
      aud: "mcp-egress-proxy",
      jti: `jti-${Date.now()}-${leaseSequence++}`,
      workspaceId: "ws-1",
      runtimeId: "rt-1",
      connectionId: "conn-1",
      releaseId: "rel-1",
      policyRevisionId: "pol-1",
      policyDigest: basePolicy().manifestDigest,
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
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: (r) => { auditRecords.push(r); } },
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
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
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
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
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
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
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

test("admin policy push rejects a snapshot whose canonical digest was tampered", async () => {
  const cache = new McpEgressPolicyCache();
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    adminToken: "admin-secret",
  });
  const { url, close } = await server.start();
  try {
    const policy = basePolicy();
    const tampered = { ...buildSnapshot(policy), revision: { ...policy, upstream: { ...policy.upstream, origin: "https://evil.example.com" } } };
    const res = await fetch(`${url}/v1/admin/policies`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dofe-admin-token": "admin-secret" },
      body: JSON.stringify(tampered),
    });
    assert.equal(res.status, 400);
    assert.equal(cache.get(policy.id), undefined);
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
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
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

test("forwards only MCP protocol headers and counts successful response bytes", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot(basePolicy()));
  const auditRecords: Array<{ sizeBucket?: string }> = [];
  let forwardedHeaders: Record<string, string> | undefined;
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: (record) => { auditRecords.push(record); } },
    forwardToUpstream: async (_policy, _claims, _request, headers) => {
      forwardedHeaders = headers;
      return {
        ok: true,
        upstreamHost: "github-mcp.example.com",
        response: {
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "application/json" },
          body: byteStream("ok"),
        },
      };
    },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `DofeEgressLease ${buildLeaseToken()}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        cookie: "must-not-leave-runtime=true",
        "x-custom": "must-not-leave-runtime",
      },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(forwardedHeaders, {
      accept: "*/*",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    });
    assert.equal(auditRecords.at(-1)?.sizeBucket, "0-1k");
  } finally {
    await close();
  }
});

test("a lease is reusable only within its bound proxy session", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot(basePolicy()));
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    forwardToUpstream: async () => ({
      ok: true,
      upstreamHost: "github-mcp.example.com",
      response: { statusCode: 200, statusMessage: "OK", headers: {}, body: null },
    }),
  });
  const { url, close } = await server.start();
  const lease = buildLeaseToken();
  const headers = { authorization: `DofeEgressLease ${lease}`, "x-dofe-egress-session": "session-a" };
  try {
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 200);
    const replay = await fetch(`${url}/mcp`, {
      headers: { authorization: `DofeEgressLease ${lease}`, "x-dofe-egress-session": "session-b" },
    });
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { error: string }).error, "mcp_egress.lease_replayed");
  } finally {
    await close();
  }
});

test("enforces the policy concurrent stream limit", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot({ ...basePolicy(), maxConcurrentStreams: 1 }));
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let releaseForward: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { releaseForward = resolve; });
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    forwardToUpstream: async () => {
      markEntered?.();
      await released;
      return {
        ok: true,
        upstreamHost: "github-mcp.example.com",
        response: { statusCode: 200, statusMessage: "OK", headers: {}, body: null },
      };
    },
  });
  const { url, close } = await server.start();
  try {
    const first = fetch(`${url}/mcp`, { headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` } });
    await entered;
    const second = await fetch(`${url}/mcp`, { headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` } });
    assert.equal(second.status, 429);
    releaseForward?.();
    assert.equal((await first).status, 200);
  } finally {
    releaseForward?.();
    await close();
  }
});

test("rejects a request body over the policy limit before forwarding", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot({ ...basePolicy(), maxRequestBytes: 3 }));
  let forwarded = false;
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    forwardToUpstream: async () => {
      forwarded = true;
      throw new Error("must not forward");
    },
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: `DofeEgressLease ${buildLeaseToken()}`, "content-type": "application/json" },
      body: "oversized",
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "mcp_egress.request_too_large");
    assert.equal(forwarded, false);
  } finally {
    await close();
  }
});

test("rejects a declared oversized upstream response before writing headers", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot({ ...basePolicy(), maxResponseBytes: 3 }));
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    forwardToUpstream: async () => ({
      ok: true,
      upstreamHost: "github-mcp.example.com",
      response: {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-length": "10" },
        body: byteStream("0123456789"),
      },
    }),
  });
  const { url, close } = await server.start();
  try {
    const res = await fetch(`${url}/mcp`, {
      headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` },
    });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "mcp_egress.response_too_large");
  } finally {
    await close();
  }
});

test("revoke endpoint requires admin token and revokes the policy", async () => {
  const cache = new McpEgressPolicyCache();
  cache.set(buildSnapshot(basePolicy()));
  const server = new McpEgressProxyServer({
    port: 0,
    host: "127.0.0.1",
    leaseVerifier: buildLeaseVerifier(cache),
    policyCache: cache,
    auditSink: { record: () => undefined },
    adminToken: "admin-secret",
  });
  const { url, close } = await server.start();
  try {
    const noToken = await fetch(`${url}/v1/admin/policies/pol-1/revoke`, { method: "POST" });
    assert.equal(noToken.status, 401);

    const badToken = await fetch(`${url}/v1/admin/policies/pol-1/revoke`, {
      method: "POST",
      headers: { "x-dofe-admin-token": "wrong" },
    });
    assert.equal(badToken.status, 401);

    const ok = await fetch(`${url}/v1/admin/policies/pol-1/revoke`, {
      method: "POST",
      headers: { "x-dofe-admin-token": "admin-secret" },
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { revoked: string }).revoked, "pol-1");

    const after = await fetch(`${url}/mcp`, {
      headers: { authorization: `DofeEgressLease ${buildLeaseToken()}` },
    });
    assert.equal(after.status, 403);
    assert.equal(((await after.json()) as { error: string }).error, "mcp_egress.lease_revoked");
  } finally {
    await close();
  }
});

function byteStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
