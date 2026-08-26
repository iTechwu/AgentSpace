import type {
  ToolSurfaceCallResult,
  ToolSurfaceLaunchContext,
  ToolSurfaceProvider,
  ToolSurfaceSessionContext,
} from "@dofe-agent/domain";

export interface McpConnectorConnectionInput {
  connectionId: string;
  endpoint: string;
  transport?: "streamable_http";
  headers?: Record<string, string>;
  approvedTools?: string[];
  risk?: "low" | "medium" | "high";
}

export interface McpConnectorClientOptions {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

/** Runtime-side client for the independent MCP Connector process. */
export class McpConnectorClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: McpConnectorClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("mcp.connector_base_url_invalid");
    this.baseUrl = baseUrl;
    this.authToken = options.authToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<{ status: "ok"; sessions: number; independentEgress: true }> {
    const response = await this.request("/health", { method: "GET" });
    if (!response.ok) throw new Error("mcp.connector_unhealthy");
    return await response.json() as { status: "ok"; sessions: number; independentEgress: true };
  }

  async openSession(input: ToolSurfaceSessionContext & { connection: McpConnectorConnectionInput }): Promise<ToolSurfaceLaunchContext> {
    const response = await this.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        taskId: input.taskId,
        runtimeId: input.runtimeId,
        requestedCapabilities: input.requestedCapabilities,
        connection: input.connection,
      }),
    });
    return await this.readJsonOrThrow<ToolSurfaceLaunchContext>(response);
  }

  async call(input: { sessionId: string; toolId: string; arguments: unknown; eventId?: string }): Promise<ToolSurfaceCallResult> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/calls`, {
      method: "POST",
      body: JSON.stringify({ toolId: input.toolId, arguments: input.arguments, eventId: input.eventId }),
    });
    return await this.readJsonOrThrow<ToolSurfaceCallResult>(response);
  }

  async close(sessionId: string, reason = "task_complete"): Promise<void> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error("mcp.connector_close_failed");
  }

  asToolSurfaceProvider(connection: McpConnectorConnectionInput): ToolSurfaceProvider {
    let activeSessionId: string | undefined;
    return {
      id: "mcp",
      contractVersion: "1",
      openSession: async (input) => {
        const context = await this.openSession({ ...input, connection });
        activeSessionId = context.sessionId;
        return context;
      },
      call: (input) => this.call(input),
      close: async (input) => {
        await this.close(input.sessionId || activeSessionId || "", input.reason);
        if (activeSessionId === input.sessionId) activeSessionId = undefined;
      },
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("x-dofe-connector-contract", "1");
    if (this.authToken) headers.set("authorization", `Bearer ${this.authToken}`);
    return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private async readJsonOrThrow<T>(response: Response): Promise<T> {
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
        ? (payload as Record<string, string>).error
        : "mcp.connector_request_failed";
      throw new Error(code);
    }
    return payload as T;
  }
}
