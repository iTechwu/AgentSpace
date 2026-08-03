import assert from "node:assert/strict";
import test from "node:test";
import type { McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { buildMcpEgressProxyRequestHeaders, createMcpEgressProxyClient } from "./egress-client.ts";

function makeSnapshot(id = "pol-test"): McpEgressPolicySnapshot {
  return {
    revision: {
      id,
      workspaceId: "ws-test",
      connectionId: "conn-test",
      releaseId: "rel-test",
      manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      upstream: {
        origin: "https://mcp.example.test",
        allowedHosts: ["mcp.example.test"],
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
      createdAt: new Date().toISOString(),
    },
    revoked: false,
    fetchedAt: new Date().toISOString(),
  };
}

test("buildMcpEgressProxyRequestHeaders returns DofeEgressLease Authorization header", () => {
  const client = createMcpEgressProxyClient({
    proxyBaseUrl: "http://proxy.test",
    leaseToken: "lease-123",
    policySnapshot: makeSnapshot(),
    proxySessionId: "proxy-session-123",
  });
  const headers = buildMcpEgressProxyRequestHeaders(client);
  assert.equal(headers.Authorization, "DofeEgressLease lease-123");
  assert.equal(headers["X-Dofe-Egress-Session"], "proxy-session-123");
});

test("ensurePolicyPushed posts the snapshot to /v1/admin/policies with admin token", async () => {
  const snapshot = makeSnapshot("pol-push-1");
  let captured: { url: string; init: RequestInit } | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ accepted: snapshot.revision.id }), { status: 200 });
  };

  try {
    const client = createMcpEgressProxyClient({
      proxyBaseUrl: "http://proxy.test",
      leaseToken: "lease-123",
      policySnapshot: snapshot,
      adminToken: "admin-secret",
    });
    await client.ensurePolicyPushed();
    assert.ok(captured);
    assert.equal(captured!.url, "http://proxy.test/v1/admin/policies");
    assert.equal((captured!.init.method as string | undefined) ?? "POST", "POST");
    const capturedHeaders = captured!.init.headers as Record<string, string>;
    assert.equal(capturedHeaders["x-dofe-admin-token"], "admin-secret");
    assert.equal(capturedHeaders["content-type"], "application/json");
    assert.equal(JSON.parse(captured!.init.body as string).revision.id, snapshot.revision.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensurePolicyPushed only pushes the same revision once", async () => {
  const snapshot = makeSnapshot("pol-dedup");
  let calls = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ accepted: snapshot.revision.id }), { status: 200 });
  };

  try {
    const client = createMcpEgressProxyClient({
      proxyBaseUrl: "http://proxy.test",
      leaseToken: "lease-123",
      policySnapshot: snapshot,
    });
    await client.ensurePolicyPushed();
    await client.ensurePolicyPushed();
    await client.ensurePolicyPushed();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensurePolicyPushed throws when the proxy rejects the push", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request", { status: 400 });

  try {
    const client = createMcpEgressProxyClient({
      proxyBaseUrl: "http://proxy.test",
      leaseToken: "lease-123",
      policySnapshot: makeSnapshot("pol-bad"),
    });
    await assert.rejects(client.ensurePolicyPushed(), /Failed to push policy snapshot to proxy/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
