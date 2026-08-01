import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedMcpConnection, RuntimeMcpClient } from "@dofe-agent/domain";
import { McpGateway, type McpGatewayTaskSession, type McpToolAuditRecord } from "./gateway.ts";

const CONNECTION_ID = "mcp-conn-test-1";
const TASK_ID = "task-test-1";

function buildTaskSession(): McpGatewayTaskSession {
  return {
    taskId: TASK_ID,
    runtimeId: "runtime-1",
    connections: [
      {
        connectionId: CONNECTION_ID,
        catalogItemSlug: "github",
        displayName: "GitHub MCP",
        transport: "streamable_http",
        endpoint: "https://github-mcp.example.com/mcp",
        allowedHosts: ["github-mcp.example.com"],
        approvedTools: ["search_repos"],
        nonSecretParams: {},
        secrets: { Authorization: "Bearer secret-token" },
        tools: [
          { id: `mcp:${CONNECTION_ID}:search_repos`, connectionId: CONNECTION_ID, name: "search_repos", description: "Search repositories", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        ],
      },
    ],
  };
}

function buildMockClient(): { client: RuntimeMcpClient; calls: Array<{ toolName: string; arguments: unknown; connection: ResolvedMcpConnection }> } {
  const calls: Array<{ toolName: string; arguments: unknown; connection: ResolvedMcpConnection }> = [];
  const client: RuntimeMcpClient = {
    verify: async () => ({ status: "ready", discoveredTools: [] }),
    call: async (input) => {
      calls.push({ toolName: input.toolName, arguments: input.arguments, connection: input.connection });
      if (input.toolName === "search_repos") {
        return { ok: true, result: { items: [{ name: "acme/foo" }] } };
      }
      return { ok: false, error: { code: "mcp.tool_not_approved", safeMessage: "not approved" } };
    },
  };
  return { client, calls };
}

let gateway: McpGateway;
let audits: McpToolAuditRecord[] = [];

before(async () => {
  audits = [];
  gateway = new McpGateway((audit) => audits.push(audit), buildMockClient().client);
  await gateway.start();
});

after(async () => {
  await gateway.close();
});

test("gateway serves approved tools with sanitized names and never leaks the endpoint or secrets", async () => {
  const session = gateway.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    const name = listed.tools[0]?.name;
    assert.ok(name && /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name), `sanitized name ${name} must be MCP-valid`);
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes("https://github-mcp.example.com"), false);
    assert.equal(serialized.includes("secret-token"), false);
  } finally {
    await client.close();
    session.revoke();
  }
});

test("gateway routes an approved tool call through the client and emits an audit", async () => {
  const mock = buildMockClient();
  const g = new McpGateway((audit) => audits.push(audit), mock.client);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const name = listed.tools[0]!.name;
    const before = audits.length;
    const result = await client.callTool({ name, arguments: { q: "acme" } });
    assert.ok(!result.isError, `call failed: ${JSON.stringify(result.content)}`);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.toolName, "search_repos");
    assert.equal(mock.calls[0]?.connection.secrets.Authorization, "Bearer secret-token");
    assert.equal(audits.length, before + 1);
    const audit = audits[audits.length - 1];
    assert.equal(audit?.outcome, "succeeded");
    assert.equal(audit?.taskId, TASK_ID);
    assert.equal(audit?.toolName, "search_repos");
  } finally {
    await client.close();
    session.revoke();
    await g.close();
  }
});

test("gateway rejects tools that are not in the task allow-list", async () => {
  const mock = buildMockClient();
  const g = new McpGateway(() => undefined, mock.client);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "mcp_other_secret_tool", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(mock.calls.length, 0);
  } finally {
    await client.close();
    session.revoke();
    await g.close();
  }
});

test("revoked sessions reject subsequent requests", async () => {
  const g = new McpGateway(() => undefined, buildMockClient().client);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const url = session.url;
  session.revoke();
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await assert.rejects(() => client.connect(transport));
  await g.close();
});
