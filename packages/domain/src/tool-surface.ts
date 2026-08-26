/** Generic runtime tool contract. MCP is one provider, not an AgentRouter concern. */
export type ToolSurfaceRisk = "low" | "medium" | "high";

export interface ToolSurfaceTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolSurfaceRisk;
}

export interface ToolSurfaceSessionContext {
  taskId: string;
  runtimeId: string;
  requestedCapabilities: string[];
}

export interface ToolSurfaceLaunchContext {
  providerId: string;
  contractVersion: "1";
  sessionId: string;
  tools: ToolSurfaceTool[];
  /** Provider-native configuration; AgentRouter treats this as opaque. */
  clientConfig?: unknown;
}

export interface ToolSurfaceProvider {
  id: string;
  contractVersion: "1";
  openSession(input: ToolSurfaceSessionContext): Promise<ToolSurfaceLaunchContext>;
  call(input: { sessionId: string; toolId: string; arguments: unknown }): Promise<ToolSurfaceCallResult>;
  close(input: { sessionId: string; reason: string }): Promise<void>;
}

export type ToolSurfaceCallResult =
  | { ok: true; result: unknown; eventId?: string }
  | { ok: false; code: string; message: string; retryable?: boolean; eventId?: string };
