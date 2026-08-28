import assert from "node:assert/strict";
import test from "node:test";
import { McpConnectorClient } from "./connector-client.ts";

test("connector client sends generic ToolSurface requests with task/runtime context", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new McpConnectorClient({
    baseUrl: "http://127.0.0.1:8787",
    authToken: "connector-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ providerId: "mcp", contractVersion: "1", sessionId: "s1", tools: [], clientConfig: { connectorSessionId: "s1" } }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const context = await client.openSession({
    taskId: "task-1",
    runtimeId: "runtime-1",
    requestedCapabilities: ["mcp"],
    connection: { connectionId: "connection-1", endpoint: "https://mcp.example.test/mcp", approvedTools: ["search"] },
  });
  assert.equal(context.sessionId, "s1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/sessions");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer connector-secret");
  assert.match(String(calls[0].init?.body), /task-1/);
});
