import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpTaskSessionConnection, ResolvedMcpConnection } from "@dofe-agent/domain";
import { redactMcpText } from "@dofe-agent/services";
import { createRuntimeMcpClient } from "./client.ts";

export interface McpToolAuditRecord {
  connectionId: string;
  taskId: string;
  toolName: string;
  outcome: "succeeded" | "failed";
  latencyMs?: number;
  safeSummary?: string;
}

export interface McpGatewayTaskSession {
  taskId: string;
  runtimeId: string;
  workspaceId: string;
  connections: McpTaskSessionConnection[];
}

interface RegisteredTool {
  connectionId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpSessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

export interface McpGatewayValidateConnectionResult {
  ok: true;
  approvedTools: string[];
}

export type McpGatewayValidateConnection = (input: {
  taskId: string;
  workspaceId: string;
  connectionId: string;
  toolName: string;
}) => Promise<McpGatewayValidateConnectionResult | { ok: false }>;

/**
 * Daemon-resident loopback MCP gateway.
 *
 * The daemon holds the resolved connection bundles (endpoint + secrets) in
 * memory; the Provider-visible task bundle and the Provider's own MCP config
 * contain ONLY the loopback gateway URL and a random session token. Every tool
 * call is validated against the task session's connection/tool allow-list and
 * routed through RuntimeMcpClient, which is the only component that talks to a
 * remote MCP server. Sessions are revoked at task end / cancel / timeout and
 * on daemon shutdown.
 */
export class McpGateway {
  private httpServer: HttpServer | null = null;
  private port = 0;
  private readonly taskSessions = new Map<string, McpGatewayTaskSession>();
  private readonly mcpSessions = new Map<string, McpSessionEntry>();
  private readonly taskSessionToMcpSessions = new Map<string, Set<string>>();
  private readonly onAudit: (audit: McpToolAuditRecord) => void | Promise<void>;
  private readonly mcpClient: ReturnType<typeof createRuntimeMcpClient>;
  private readonly validateConnection?: McpGatewayValidateConnection;

  constructor(
    onAudit: (audit: McpToolAuditRecord) => void | Promise<void>,
    mcpClient?: ReturnType<typeof createRuntimeMcpClient>,
    validateConnection?: McpGatewayValidateConnection,
  ) {
    this.onAudit = onAudit;
    this.mcpClient = mcpClient ?? createRuntimeMcpClient();
    this.validateConnection = validateConnection;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.httpServer = createServer((req, res) => void this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.httpServer.address();
    if (typeof address === "object" && address) {
      this.port = address.port;
    }
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isRunning(): boolean {
    return Boolean(this.httpServer);
  }

  createTaskSession(input: McpGatewayTaskSession): { url: string; revoke: () => void } {
    const token = randomBytes(16).toString("hex");
    this.taskSessions.set(token, input);
    this.taskSessionToMcpSessions.set(token, new Set());
    return {
      url: `${this.baseUrl}/mcp?session=${token}`,
      revoke: () => {
        const mcpSessionIds = this.taskSessionToMcpSessions.get(token);
        if (mcpSessionIds) {
          for (const id of mcpSessionIds) {
            const entry = this.mcpSessions.get(id);
            if (entry) {
              entry.server.close().catch(() => undefined);
              entry.transport.close().catch(() => undefined);
              this.mcpSessions.delete(id);
            }
          }
          this.taskSessionToMcpSessions.delete(token);
        }
        this.taskSessions.delete(token);
      },
    };
  }

  async close(): Promise<void> {
    for (const entry of this.mcpSessions.values()) {
      await entry.server.close().catch(() => undefined);
      await entry.transport.close().catch(() => undefined);
    }
    this.mcpSessions.clear();
    this.taskSessionToMcpSessions.clear();
    this.taskSessions.clear();
    const server = this.httpServer;
    this.httpServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("session") ?? "";
    const taskSession = token ? this.taskSessions.get(token) : undefined;
    if (!taskSession) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mcp.session_not_found" }));
      return;
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionKey = typeof sessionHeader === "string" ? sessionHeader : "";
    let entry = sessionKey ? this.mcpSessions.get(sessionKey) : undefined;
    if (!entry) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (id) => {
          this.mcpSessions.set(id, { server, transport });
          this.taskSessionToMcpSessions.get(token)?.add(id);
        },
      });
      const server = this.buildMcpServer(taskSession);
      await server.connect(transport);
      entry = { server, transport };
    }

    try {
      await entry.transport.handleRequest(req, res, undefined);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "mcp.gateway_internal" }));
    }
  }

  private buildMcpServer(taskSession: McpGatewayTaskSession): Server {
    const tools = new Map<string, RegisteredTool>();
    for (const connection of taskSession.connections) {
      for (const tool of connection.tools) {
        if (!connection.approvedTools.includes(tool.name)) continue;
        tools.set(sanitizeToolName(tool.id), {
          connectionId: connection.connectionId,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    const server = new Server({ name: "dofe-mcp-gateway", version: "1" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Array.from(tools.entries()).map(([name, tool]) => ({
        name,
        description: tool.description || tool.toolName,
        inputSchema: tool.inputSchema,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const requestedName = String(request.params.name ?? "");
      const registered = tools.get(requestedName);
      if (!registered) {
        return { content: [{ type: "text", text: "Unknown MCP tool." }], isError: true };
      }
      const connection = taskSession.connections.find((c) => c.connectionId === registered.connectionId);
      if (!connection) {
        return { content: [{ type: "text", text: "Connection is not in this task session." }], isError: true };
      }

      // Per-call re-validation: an administrator may have disabled or reconfigured
      // the connection while the task is still running. Stop the call if the
      // current DB state no longer allows this tool.
      if (this.validateConnection) {
        const validation = await this.validateConnection({
          taskId: taskSession.taskId,
          workspaceId: taskSession.workspaceId,
          connectionId: registered.connectionId,
          toolName: registered.toolName,
        });
        if (!validation.ok || !validation.approvedTools.includes(registered.toolName)) {
          return { content: [{ type: "text", text: "Connection is no longer available for this tool." }], isError: true };
        }
      }

      const resolved: ResolvedMcpConnection = {
        connectionId: connection.connectionId,
        runtimeId: taskSession.runtimeId,
        workspaceId: taskSession.workspaceId,
        transport: connection.transport,
        endpoint: connection.endpoint,
        allowedHosts: connection.allowedHosts,
        approvedTools: connection.approvedTools,
        secrets: connection.secrets,
        nonSecretParams: connection.nonSecretParams,
      };
      const startedAt = Date.now();
      const result = await this.mcpClient.call({
        connection: resolved,
        toolName: registered.toolName,
        arguments: request.params.arguments,
        taskId: taskSession.taskId,
      });
      const latencyMs = Date.now() - startedAt;
      if (!result.ok) {
        await this.emitAudit(taskSession, registered.connectionId, registered.toolName, "failed", latencyMs, result.error.safeMessage);
        return { content: [{ type: "text", text: result.error.safeMessage }], isError: true };
      }
      await this.emitAudit(taskSession, registered.connectionId, registered.toolName, "succeeded", latencyMs, undefined);
      const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "");
      return { content: [{ type: "text", text }] };
    });

    return server;
  }

  private async emitAudit(
    taskSession: McpGatewayTaskSession,
    connectionId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
    latencyMs: number,
    safeSummary?: string,
  ): Promise<void> {
    try {
      await this.onAudit({
        connectionId,
        taskId: taskSession.taskId,
        toolName,
        outcome,
        latencyMs,
        safeSummary: safeSummary ? redactMcpText(safeSummary).slice(0, 400) : undefined,
      });
    } catch {
      // Audit reporting must never break the tool call.
    }
  }
}

function sanitizeToolName(id: string): string {
  // MCP tool names may not contain colons. Keep a stable, reversible-enough
  // mapping by replacing ':' with '_' and capping the length with a short hash.
  const raw = id.replace(/:/g, "_");
  if (raw.length <= 64) return raw;
  const hash = randomBytes(4).toString("hex");
  return `${raw.slice(0, 55)}_${hash}`;
}
