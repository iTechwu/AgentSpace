import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createConnectorHttpServer, isToolApproved, McpConnectorService } from "./server.ts";

test("connector health advertises independent egress without opening a session", async () => {
  const service = new McpConnectorService();
  const http = createConnectorHttpServer(service, { host: "127.0.0.1", port: 0 });
  const url = await new Promise<string>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      if (!address || typeof address === "string") return reject(new Error("missing address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  try {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", sessions: 0, independentEgress: true, networkMode: "open" });
  } finally {
    await http.close();
  }
});

test("connector rejects credential-bearing endpoints before network access", async () => {
  const service = new McpConnectorService();
  await assert.rejects(
    service.openSession({ taskId: "task", runtimeId: "runtime", connection: { connectionId: "c", endpoint: "https://user:pass@example.com/mcp" } }),
    /credential-free/,
  );
});

test("connector tool approval is fail-closed for an empty allow-list", () => {
  assert.equal(isToolApproved("search", []), false);
  assert.equal(isToolApproved("search", undefined), false);
  assert.equal(isToolApproved("search", ["search"]), true);
});

test("restricted network mode enforces the configured host allow-list before connecting", async () => {
  const service = new McpConnectorService({ networkMode: "restricted", allowedHosts: ["allowed.example"] });
  await assert.rejects(
    service.openSession({
      taskId: "task",
      runtimeId: "runtime",
      connection: { connectionId: "c", endpoint: "https://blocked.example/mcp", approvedTools: ["search"] },
    }),
    /network policy/,
  );
});

test("connector HTTP API preserves network policy error codes", async () => {
  const service = new McpConnectorService({ networkMode: "restricted", allowedHosts: ["allowed.example"] });
  const http = createConnectorHttpServer(service, { host: "127.0.0.1", port: 0, authToken: "test-token" });
  const url = await listen(http.server);
  try {
    const response = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ taskId: "task", runtimeId: "runtime", connection: { connectionId: "c", endpoint: "https://blocked.example/mcp", approvedTools: ["search"] } }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "connector.network_denied", message: "MCP endpoint is not allowed by the connector network policy." });
  } finally {
    await http.close();
  }
});

test("connector exposes an independent MCP session endpoint to a provider client", async () => {
  const upstream = new Server({ name: "fake-mcp", version: "1" }, { capabilities: { tools: {} } });
  upstream.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "search", description: "Search test data", inputSchema: { type: "object" } }],
  }));
  upstream.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const upstreamTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "upstream-session", enableJsonResponse: true });
  await upstream.connect(upstreamTransport);
  const upstreamHttp = createServer((req, res) => void upstreamTransport.handleRequest(req, res, undefined));
  const upstreamUrl = await listen(upstreamHttp);

  const service = new McpConnectorService({ timeoutMs: 5_000 });
  const connectorHttp = createConnectorHttpServer(service, { host: "127.0.0.1", port: 0, authToken: "test-token" });
  const connectorUrl = await listen(connectorHttp.server);
  try {
    const context = await service.openSession({
      taskId: "task-1",
      runtimeId: "runtime-1",
      connection: { connectionId: "connection-1", endpoint: `${upstreamUrl}/mcp`, approvedTools: ["search"] },
    });
    const config = context.clientConfig as { mcpPath: string };
    const provider = new Client({ name: "fake-provider", version: "1" }, { capabilities: {} });
    await provider.connect(new StreamableHTTPClientTransport(new URL(`${connectorUrl}${config.mcpPath}`)));

    const tools = await provider.listTools();
    assert.equal(tools.tools[0]?.name, "search");
    const result = await provider.callTool({ name: "search", arguments: {} });
    assert.equal((result as { content?: Array<{ type?: string }> }).content?.[0]?.type, "text");
    await service.close({ sessionId: context.sessionId, reason: "test" });
    await provider.close();
  } finally {
    await connectorHttp.close();
    await upstreamTransport.close().catch(() => undefined);
    await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
    await upstream.close().catch(() => undefined);
  }
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
}
