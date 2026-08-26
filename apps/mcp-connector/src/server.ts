import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSurfaceCallResult, ToolSurfaceLaunchContext, ToolSurfaceTool } from "@dofe-agent/domain";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TOOLS = 128;
const MAX_SCHEMA_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ConnectorConnectionInput {
  connectionId: string;
  endpoint: string;
  transport?: "streamable_http";
  headers?: Record<string, string>;
  approvedTools?: string[];
  risk?: "low" | "medium" | "high";
}

export interface ConnectorSessionRecord {
  sessionId: string;
  taskId: string;
  runtimeId: string;
  connection: ConnectorConnectionInput;
  client: Client;
  tools: ToolSurfaceTool[];
  createdAt: string;
  expiresAt: number;
  mcpSessions: Map<string, { server: Server; transport: StreamableHTTPServerTransport }>;
}

export class McpConnectorService {
  private readonly sessions = new Map<string, ConnectorSessionRecord>();
  private readonly timeoutMs: number;
  private readonly networkMode: "open" | "restricted";
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(options: { timeoutMs?: number; networkMode?: "open" | "restricted"; allowedHosts?: readonly string[] } = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(600_000, Math.max(5_000, Math.trunc(options.timeoutMs!)))
      : DEFAULT_TIMEOUT_MS;
    this.networkMode = options.networkMode ?? (process.env.MCP_CONNECTOR_NETWORK_MODE === "restricted" ? "restricted" : "open");
    const configuredHosts = options.allowedHosts ?? (process.env.MCP_CONNECTOR_ALLOWED_HOSTS ?? "").split(",");
    this.allowedHosts = new Set(configuredHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  }

  async openSession(input: {
    taskId: string;
    runtimeId: string;
    connection: ConnectorConnectionInput;
    requestedCapabilities?: string[];
    ttlMs?: number;
  }): Promise<ToolSurfaceLaunchContext> {
    const connection = validateConnectionInput(input.connection);
    this.assertNetworkPolicy(connection.endpoint);
    const sessionId = randomUUID();
    const endpoint = new URL(connection.endpoint);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: sanitizeHeaders(connection.headers) },
      fetch: (request, init) => fetchWithTimeout(request, init, this.timeoutMs),
    });
    const client = new Client({ name: "dofe-mcp-connector", version: "1" }, { capabilities: {} });
    try {
      await withTimeout(client.connect(transport), this.timeoutMs);
      const result = await withTimeout(client.listTools(), this.timeoutMs);
      const tools = (result.tools ?? []).slice(0, MAX_TOOLS).flatMap((tool) => {
        // Approval is an allow-list. An empty list must fail closed, matching
        // the control-plane gateway semantics, rather than exposing discovery
        // results by default.
        if (!isToolApproved(tool.name, connection.approvedTools)) return [];
        const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
        if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) return [];
        return [{
          id: `mcp:${connection.connectionId}:${tool.name}`,
          name: tool.name,
          description: String(tool.description ?? "").slice(0, 2_048),
          inputSchema,
          risk: connection.risk ?? "medium",
        } satisfies ToolSurfaceTool];
      });
      const ttlMs = Math.min(30 * 60_000, Math.max(30_000, Math.trunc(input.ttlMs ?? 10 * 60_000)));
      this.sessions.set(sessionId, {
        sessionId,
        taskId: input.taskId,
        runtimeId: input.runtimeId,
        connection,
        client,
        tools,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + ttlMs,
        mcpSessions: new Map(),
      });
      return {
        providerId: "mcp",
        contractVersion: "1",
        sessionId,
        tools,
        clientConfig: { connectorSessionId: sessionId, mcpPath: `/mcp?session=${encodeURIComponent(sessionId)}` },
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw classifyConnectorError(error);
    }
  }

  async call(input: { sessionId: string; toolId: string; arguments: unknown; eventId?: string }): Promise<ToolSurfaceCallResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return { ok: false, code: "connector.session_not_found", message: "Tool session is not available." };
    if (session.expiresAt <= Date.now()) {
      await this.close({ sessionId: input.sessionId, reason: "expired" });
      return { ok: false, code: "connector.session_expired", message: "Tool session expired.", retryable: true, eventId: input.eventId };
    }
    const tool = session.tools.find((candidate) => candidate.id === input.toolId);
    if (!tool) return { ok: false, code: "connector.tool_not_approved", message: "Tool is not approved for this session.", eventId: input.eventId };
    try {
      const result = await withTimeout(session.client.callTool({ name: tool.name, arguments: (input.arguments ?? {}) as Record<string, unknown> }), this.timeoutMs);
      if (result?.isError) return { ok: false, code: "connector.upstream_tool_error", message: "MCP tool returned an error.", retryable: true, eventId: input.eventId };
      return { ok: true, result: redactResult(result?.content), eventId: input.eventId };
    } catch (error) {
      return { ok: false, code: classifyConnectorError(error).code, message: classifyConnectorError(error).message, retryable: true, eventId: input.eventId };
    }
  }

  async close(input: { sessionId: string; reason: string }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    this.sessions.delete(input.sessionId);
    for (const mcpSession of session.mcpSessions.values()) {
      await mcpSession.server.close().catch(() => undefined);
      await mcpSession.transport.close().catch(() => undefined);
    }
    await session.client.close().catch(() => undefined);
  }

  async handleMcpRequest(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "connector.session_not_found" }));
      return;
    }
    const requestedSessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : "";
    let mcpSession = requestedSessionId ? session.mcpSessions.get(requestedSessionId) : undefined;
    if (!mcpSession) {
      let server!: Server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          session.mcpSessions.set(id, { server, transport });
        },
      });
      server = new Server({ name: "dofe-mcp-connector", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: session.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = session.tools.find((candidate) => candidate.name === String(request.params.name ?? ""));
        if (!tool) return { content: [{ type: "text", text: "Tool is not approved for this session." }], isError: true };
        const result = await this.call({ sessionId, toolId: tool.id, arguments: request.params.arguments ?? {} });
        if (!result.ok) return { content: [{ type: "text", text: result.message }], isError: true };
        return { content: Array.isArray(result.result) ? result.result : [{ type: "text", text: JSON.stringify(result.result) }] };
      });
      await server.connect(transport);
      mcpSession = { server, transport };
    }
    await mcpSession.transport.handleRequest(req, res, undefined);
  }

  health(): { status: "ok"; sessions: number; independentEgress: true; networkMode: "open" | "restricted" } {
    return { status: "ok", sessions: this.sessions.size, independentEgress: true, networkMode: this.networkMode };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close({ sessionId, reason: "shutdown" })));
  }

  private assertNetworkPolicy(endpoint: string): void {
    if (this.networkMode !== "restricted") return;
    const hostname = new URL(endpoint).hostname.toLowerCase();
    if (this.allowedHosts.size === 0) {
      throw Object.assign(new Error("Restricted network mode requires MCP_CONNECTOR_ALLOWED_HOSTS."), { code: "connector.network_policy_missing" });
    }
    if (!this.allowedHosts.has(hostname)) {
      throw Object.assign(new Error("MCP endpoint is not allowed by the connector network policy."), { code: "connector.network_denied" });
    }
  }
}

export function createConnectorHttpServer(service: McpConnectorService, options: {
  host?: string;
  port?: number;
  authToken?: string;
} = {}): { server: ReturnType<typeof createServer>; start: () => Promise<string>; close: () => Promise<void> } {
  const host = options.host ?? process.env.MCP_CONNECTOR_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MCP_CONNECTOR_PORT ?? "8787");
  const authToken = options.authToken ?? process.env.MCP_CONNECTOR_AUTH_TOKEN?.trim();
  const server = createServer((req, res) => void handleRequest(req, res, service, authToken));
  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(`http://${host}:${port}`));
    }),
    close: async () => {
      await service.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, service: McpConnectorService, authToken?: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // The random task session in the MCP URL is the provider-facing capability
  // token. Management/session APIs still require the connector auth token.
  const isProviderMcpRoute = url.pathname === "/mcp" && Boolean(url.searchParams.get("session"));
  if (authToken && !isProviderMcpRoute && req.headers.authorization !== `Bearer ${authToken}`) {
    return writeJson(res, 401, { error: "connector.unauthorized" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") return writeJson(res, 200, service.health());
    if (url.pathname === "/mcp" && url.searchParams.get("session")) {
      return service.handleMcpRequest(url.searchParams.get("session")!, req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(req);
      const result = await service.openSession(body as Parameters<McpConnectorService["openSession"]>[0]);
      return writeJson(res, 201, result);
    }
    const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/calls|\/tools)?$/);
    if (match && req.method === "GET" && url.pathname.endsWith("/tools")) {
      const session = (service as unknown as { sessions: Map<string, ConnectorSessionRecord> }).sessions.get(match[1]);
      return session ? writeJson(res, 200, { tools: session.tools }) : writeJson(res, 404, { error: "connector.session_not_found" });
    }
    if (match && req.method === "POST" && url.pathname.endsWith("/calls")) {
      const body = await readJson(req) as { toolId: string; arguments?: unknown; eventId?: string };
      return writeJson(res, 200, await service.call({ sessionId: match[1], toolId: body.toolId, arguments: body.arguments ?? {}, eventId: body.eventId }));
    }
    if (match && req.method === "DELETE" && url.pathname.endsWith("/tools") === false) {
      await service.close({ sessionId: match[1], reason: "client_request" });
      return writeJson(res, 204, undefined);
    }
    writeJson(res, 404, { error: "connector.not_found" });
  } catch (error) {
    const classified = classifyConnectorError(error);
    writeJson(res, classified.code === "connector.invalid_request" ? 400 : 502, { error: classified.code, message: classified.message });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { code: "connector.invalid_request" });
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Request body must be valid JSON."), { code: "connector.invalid_request" }); }
}

export function isToolApproved(toolName: string, approvedTools: readonly string[] | undefined): boolean {
  return Boolean(approvedTools?.includes(toolName));
}

function validateConnectionInput(input: ConnectorConnectionInput): ConnectorConnectionInput {
  if (!input || input.transport && input.transport !== "streamable_http") throw Object.assign(new Error("Only streamable_http is supported by connector v1."), { code: "connector.invalid_request" });
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { throw Object.assign(new Error("MCP endpoint is invalid."), { code: "connector.invalid_request" }); }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw Object.assign(new Error("MCP endpoint must be credential-free HTTP(S)."), { code: "connector.invalid_request" });
  return { ...input, endpoint: endpoint.toString(), headers: sanitizeHeaders(input.headers), approvedTools: (input.approvedTools ?? []).slice(0, MAX_TOOLS) };
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
    if (typeof value === "string" && value.length <= 8192) result[key] = value;
  }
  return result;
}

function redactResult(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 32_768);
  if (Array.isArray(value)) return value.slice(0, 128).map(redactResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, item]) => [key, redactResult(item)]));
  return value;
}

function classifyConnectorError(error: unknown): Error & { code: string; message: string } {
  const source = error as { code?: string; message?: string };
  const code = source?.code === "connector.invalid_request" ? source.code : "connector.upstream_unreachable";
  const message = code === "connector.invalid_request" ? source.message ?? "Invalid connector request." : "MCP upstream is unavailable.";
  return Object.assign(new Error(message), { code, message });
}

async function fetchWithTimeout(input: string | URL | Request, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("connector.timeout")), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
