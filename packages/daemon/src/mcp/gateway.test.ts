import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ResolvedMcpConnection, RuntimeMcpClient } from "@dofe-agent/domain";
import { McpGateway, McpGatewayPool, type McpGatewayTaskSession, type McpToolAuditRecord } from "./gateway.ts";

const CONNECTION_ID = "mcp-conn-test-1";
const TASK_ID = "task-test-1";

function buildTaskSession(): McpGatewayTaskSession {
  return {
    taskId: TASK_ID,
    runtimeId: "runtime-1",
    workspaceId: "workspace-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    connections: [
      {
        connectionId: CONNECTION_ID,
        workspaceId: "workspace-1",
        catalogItemId: "catalog-github-1",
        catalogItemSlug: "github",
        catalogItemVersion: "1.0.0",
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

function buildOpenMontageTaskSession(): McpGatewayTaskSession {
  const connectionId = "mcp-openmontage-1";
  return {
    taskId: TASK_ID,
    runtimeId: "runtime-1",
    workspaceId: "workspace-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    connections: [{
      connectionId,
      workspaceId: "workspace-1",
      catalogItemId: "catalog-openmontage-1",
      catalogItemSlug: "official-openmontage",
      catalogItemVersion: "1.0.0",
      displayName: "OpenMontage",
      transport: "managed_service",
      endpoint: "managed-service://openmontage",
      allowedHosts: [],
      approvedTools: ["submit_video_job"],
      nonSecretParams: {},
      secrets: { Authorization: "Bearer service-token" },
      tools: [{
        id: `mcp:${connectionId}:submit_video_job`,
        connectionId,
        name: "submit_video_job",
        description: "Submit a video Job",
        inputSchema: { type: "object", properties: { request: { type: "object" } } },
      }],
    }],
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
  gateway = new McpGateway((audit) => { audits.push(audit); }, buildMockClient().client);
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

test("gateway can advertise a Docker bridge address without listening on all interfaces", async () => {
  const dockerGateway = new McpGateway(
    () => undefined,
    buildMockClient().client,
    undefined,
    { listenHost: "127.0.0.1", advertisedHost: "172.31.240.1" },
  );
  await dockerGateway.start();
  try {
    const session = dockerGateway.createTaskSession(buildTaskSession());
    assert.equal(new URL(session.url).hostname, "172.31.240.1");
    session.revoke();
  } finally {
    await dockerGateway.close();
  }
});

test("gateway pool initializes one gateway per host under concurrency and retries failures", async () => {
  const pool = new McpGatewayPool();
  const pooledGateway = new McpGateway(() => undefined, buildMockClient().client);
  let createCalls = 0;
  let releaseCreate: (() => void) | undefined;
  const creationGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const create = async () => {
    createCalls += 1;
    await creationGate;
    return pooledGateway;
  };

  const first = pool.getOrCreate("172.31.240.1", create);
  const second = pool.getOrCreate("172.31.240.1", create);
  assert.equal(createCalls, 1);
  releaseCreate?.();
  assert.equal(await first, pooledGateway);
  assert.equal(await second, pooledGateway);

  let failureCalls = 0;
  await assert.rejects(pool.getOrCreate("172.31.240.2", async () => {
    failureCalls += 1;
    throw new Error("listen failed");
  }), /listen failed/);
  assert.equal(await pool.getOrCreate("172.31.240.2", async () => {
    failureCalls += 1;
    return pooledGateway;
  }), pooledGateway);
  assert.equal(failureCalls, 2);
});

test("gateway routes an approved tool call through the client and emits an audit", async () => {
  const mock = buildMockClient();
  const g = new McpGateway((audit) => { audits.push(audit); }, mock.client);
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

test("gateway injects stable trusted attribution and reports a submitted OpenMontage Job", async () => {
  const calls: Array<ResolvedMcpConnection> = [];
  const reports: Array<{ taskId: string; connectionId: string; snapshot: unknown }> = [];
  const snapshot = { jobId: "om_job_1", status: "QUEUED" };
  const client: RuntimeMcpClient = {
    verify: async () => ({ status: "ready", discoveredTools: [] }),
    call: async (input) => {
      calls.push(input.connection);
      return { ok: true, result: [{ type: "text", text: JSON.stringify(snapshot) }] };
    },
  };
  const g = new McpGateway(
    () => undefined,
    client,
    undefined,
    undefined,
    async (report) => { reports.push(report); },
  );
  await g.start();
  const session = g.createTaskSession(buildOpenMontageTaskSession());
  const provider = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  await provider.connect(new StreamableHTTPClientTransport(new URL(session.url)));
  try {
    const name = (await provider.listTools()).tools[0]!.name;
    const argumentsValue = { request: { clientRequestId: "request-1" } };
    await provider.callTool({ name, arguments: argumentsValue });
    await provider.callTool({ name, arguments: argumentsValue });

    assert.equal(reports.length, 2);
    assert.deepEqual(reports[0], { taskId: TASK_ID, connectionId: "mcp-openmontage-1", snapshot });
    const first = decodeAttribution(calls[0]!.nonSecretParams["X-Dofe-Job-Attribution"] as string);
    const second = decodeAttribution(calls[1]!.nonSecretParams["X-Dofe-Job-Attribution"] as string);
    assert.deepEqual(first, {
      workspaceId: "workspace-1",
      employeeId: "employee-1",
      runtimeId: "runtime-1",
      rootTaskId: TASK_ID,
      conversationId: "conversation-1",
      sourceInvocationId: first.sourceInvocationId,
      traceId: TASK_ID,
    });
    assert.equal(first.sourceInvocationId, second.sourceInvocationId);
    assert.equal(calls[0]!.secrets.Authorization, "Bearer service-token");
  } finally {
    await provider.close();
    session.revoke();
    await g.close();
  }
});

function decodeAttribution(value: string): Record<string, string> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, string>;
}

test("gateway fails the submit tool when the created OpenMontage Job cannot be linked", async () => {
  const client: RuntimeMcpClient = {
    verify: async () => ({ status: "ready", discoveredTools: [] }),
    call: async () => ({ ok: true, result: [{ type: "text", text: JSON.stringify({ jobId: "om_job_1" }) }] }),
  };
  const g = new McpGateway(
    () => undefined,
    client,
    undefined,
    undefined,
    async () => { throw new Error("private control-plane detail"); },
  );
  await g.start();
  const session = g.createTaskSession(buildOpenMontageTaskSession());
  const provider = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  await provider.connect(new StreamableHTTPClientTransport(new URL(session.url)));
  try {
    const name = (await provider.listTools()).tools[0]!.name;
    const result = await provider.callTool({ name, arguments: { request: { clientRequestId: "request-1" } } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /could not be linked/i);
    assert.doesNotMatch(JSON.stringify(result.content), /private control-plane detail/);
  } finally {
    await provider.close();
    session.revoke();
    await g.close();
  }
});

test("gateway uses a freshly validated egress lease for every tool call", async () => {
  const mock = buildMockClient();
  let validationCount = 0;
  const validator = async () => {
    validationCount += 1;
    return {
      ok: true as const,
      approvedTools: ["search_repos"],
      egressProxyLease: `lease-${validationCount}`,
    };
  };
  const g = new McpGateway(() => undefined, mock.client, validator);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const name = (await client.listTools()).tools[0]!.name;
    await client.callTool({ name, arguments: { q: "first" } });
    await client.callTool({ name, arguments: { q: "second" } });

    assert.equal(validationCount, 2);
    assert.deepEqual(mock.calls.map((call) => call.connection.egressProxyLease), ["lease-1", "lease-2"]);
  } finally {
    await client.close();
    session.revoke();
    await g.close();
  }
});

test("gateway rejects an approved tool call when the per-call validator reports the connection is stale", async () => {
  const mock = buildMockClient();
  const validator = async () => ({ ok: false as const });
  const g = new McpGateway(() => undefined, mock.client, validator);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const name = listed.tools[0]!.name;
    const result = await client.callTool({ name, arguments: { q: "acme" } });
    assert.equal(result.isError, true);
    assert.equal(mock.calls.length, 0);
  } finally {
    await client.close();
    session.revoke();
    await g.close();
  }
});

test("gateway calls the per-call validator with task, workspace, connection, and tool before executing", async () => {
  const mock = buildMockClient();
  const validations: Array<{ taskId: string; workspaceId: string; connectionId: string; toolName: string }> = [];
  const validator = async (input: { taskId: string; workspaceId: string; connectionId: string; toolName: string }) => {
    validations.push(input);
    return { ok: true as const, approvedTools: ["search_repos"] };
  };
  const g = new McpGateway(() => undefined, mock.client, validator);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const name = listed.tools[0]!.name;
    await client.callTool({ name, arguments: { q: "acme" } });
    assert.equal(validations.length, 1);
    assert.deepEqual(validations[0], {
      taskId: TASK_ID,
      workspaceId: "workspace-1",
      connectionId: CONNECTION_ID,
      toolName: "search_repos",
    });
    assert.equal(mock.calls.length, 1);
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

test("gateway awaits an async onAudit callback before returning the tool result", async () => {
  const mock = buildMockClient();
  const order: string[] = [];
  const g = new McpGateway(
    async (audit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`audit:${audit.outcome}`);
    },
    mock.client,
  );
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const name = listed.tools[0]!.name;
    const callPromise = client.callTool({ name, arguments: { q: "acme" } });
    assert.equal(order.length, 0, "audit should not fire before tool call completes");
    await callPromise;
    assert.deepEqual(order, ["audit:succeeded"]);
  } finally {
    await client.close();
    session.revoke();
    await g.close();
  }
});

test("revoke closes established MCP transports and removes them from gateway memory", async () => {
  const g = new McpGateway(() => undefined, buildMockClient().client);
  await g.start();
  const session = g.createTaskSession(buildTaskSession());
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(session.url));
  await client.connect(transport);
  try {
    // Internal state is private; cast to verify cleanup.
    const gateway = g as unknown as { mcpSessions: Map<string, unknown>; taskSessionToMcpSessions: Map<string, Set<string>>; taskSessions: Map<string, unknown> };
    assert.ok(gateway.mcpSessions.size > 0, "MCP session should be established after connect");
    session.revoke();
    assert.equal(gateway.mcpSessions.size, 0, "revoke should close and remove MCP sessions");
    assert.equal(gateway.taskSessionToMcpSessions.size, 0, "revoke should remove task-to-session mapping");
    assert.equal(gateway.taskSessions.size, 0, "revoke should remove task session");
  } finally {
    await client.close();
    await g.close();
  }
});

test("gateway rejects replaying another task session's mcp-session-id header", async () => {
  const g = new McpGateway(() => undefined, buildMockClient().client);
  await g.start();
  const sessionA = g.createTaskSession(buildTaskSession());
  const sessionB = g.createTaskSession(buildTaskSession());
  const clientA = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  const transportA = new StreamableHTTPClientTransport(new URL(sessionA.url));
  try {
    await clientA.connect(transportA);
    const stolenSessionId = transportA.sessionId;
    assert.ok(stolenSessionId, "client A should hold an mcp-session-id after initialize");

    // Attacker replays session A's mcp-session-id against session B's URL. The
    // gateway must refuse: the session entry belongs to a different task token.
    // (Verified via raw HTTP because the MCP SDK transparently re-initializes a
    // fresh session on a 403, which would mask the gateway's own response.)
    const status = await rawPostStatus(new URL(sessionB.url), stolenSessionId);
    assert.equal(status, 403);
  } finally {
    await clientA.close();
    sessionA.revoke();
    sessionB.revoke();
    await g.close();
  }
});

function rawPostStatus(url: URL, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "attacker", version: "1" },
      },
    }));
  });
}
