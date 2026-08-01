import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpDiscoveredTool, McpErrorCode, McpVerificationResult, ResolvedMcpConnection, RuntimeMcpClient } from "@dofe-agent/domain";
import { redactMcpText, redactToolInputSchema, validateMcpEndpoint, validateMcpResolvedAddresses } from "@dofe-agent/services";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_DISCOVERED_TOOLS = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 2_048;
const MAX_TOOL_SCHEMA_BYTES = 16_384;
const MAX_DISCOVERY_SCHEMA_BYTES = 262_144;
const CLIENT_NAME = "dofe-agent-daemon";
const CLIENT_VERSION = "1";

/**
 * The only component that talks to a remote MCP server. Lives inside the
 * Runtime container so egress is constrained by the container network policy.
 */
export function createRuntimeMcpClient(): RuntimeMcpClient {
  return {
    verify: (connection) => verifyConnection(connection),
    call: (input) => callTool(input),
  };
}

async function verifyConnection(connection: ResolvedMcpConnection): Promise<McpVerificationResult> {
  const guard = guardEndpoint(connection);
  if (!guard.ok) {
    return { status: "failed", error: { code: guard.code, safeMessage: guard.message } };
  }
  const startedAt = Date.now();
  try {
    return await withClient(connection, async (client) => {
      const toolsResult = await client.listTools();
      const discovered = normalizeDiscoveredTools(toolsResult.tools ?? []);
      if (!discovered.ok) {
        return {
          status: "failed",
          latencyMs: Date.now() - startedAt,
          error: { code: "mcp.protocol_invalid", safeMessage: discovered.message },
        };
      }
      return {
        status: "ready",
        protocolVersion: safeProtocolVersion(client),
        discoveredTools: discovered.tools,
        toolsFingerprint: discovered.tools.map((t) => `${t.name}:${t.inputSchemaDigest}`).sort().join("|"),
        latencyMs: Date.now() - startedAt,
      };
    });
  } catch (error) {
    return { status: "failed", latencyMs: Date.now() - startedAt, error: classifyError(error, connection.secrets) };
  }
}

async function callTool(input: {
  connection: ResolvedMcpConnection;
  toolName: string;
  arguments: unknown;
  taskId: string;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: McpErrorCode; safeMessage: string } }> {
  if (!input.connection.approvedTools.includes(input.toolName)) {
    return { ok: false, error: { code: "mcp.tool_not_approved", safeMessage: `Tool "${input.toolName}" is not approved for this connection.` } };
  }
  const guard = guardEndpoint(input.connection);
  if (!guard.ok) {
    return { ok: false, error: { code: guard.code, safeMessage: guard.message } };
  }
  try {
    const result = await withClient(input.connection, async (client) =>
      client.callTool({ name: input.toolName, arguments: (input.arguments ?? {}) as Record<string, unknown> }),
    );
    if (result?.isError) {
      return { ok: false, error: { code: "mcp.protocol_invalid", safeMessage: summarizeContent(result.content, input.connection.secrets) } };
    }
    return { ok: true, result: redactCallResult(result.content) };
  } catch (error) {
    return { ok: false, error: classifyError(error, input.connection.secrets) };
  }
}

async function withClient<T>(connection: ResolvedMcpConnection, fn: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(connection.endpoint);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: buildHeaders(connection) },
    fetch: (input, init) => timeoutFetch(input, init),
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {
      /* best-effort teardown */
    });
  }
}

function buildHeaders(connection: ResolvedMcpConnection): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(connection.nonSecretParams ?? {})) {
    if (typeof value === "string" && value.trim()) {
      headers[key] = value;
    }
  }
  for (const [key, value] of Object.entries(connection.secrets ?? {})) {
    if (typeof value === "string" && value.trim()) {
      headers[key] = value;
    }
  }
  return headers;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function timeoutFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  init?.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await pinnedHttpsFetch(input, { ...init, redirect: "error", signal: controller.signal });
    return limitResponseBody(response);
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Resolves and pins every MCP HTTP request to a freshly validated DNS answer.
 * `fetch` alone would resolve again after validation, leaving a DNS-rebinding
 * window. `https.request` lets us retain the original hostname for TLS SNI
 * while forcing the socket lookup to the vetted address.
 */
async function pinnedHttpsFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const validation = validateMcpResolvedAddresses(addresses.map((entry) => entry.address));
  if (!validation.ok) {
    throw new Error(validation.message ?? "MCP endpoint DNS resolution was rejected.");
  }
  const target = addresses[0]!;
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init?.headers);
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers: headersToObject(headers),
      servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    init?.signal?.addEventListener("abort", () => request.destroy(new DOMException("Aborted", "AbortError")), { once: true });
    writeRequestBody(request, init?.body).catch((error) => request.destroy(error));
  });
}

async function writeRequestBody(request: ReturnType<typeof httpsRequest>, body: unknown): Promise<void> {
  if (body === undefined || body === null) {
    request.end();
    return;
  }
  if (body instanceof ReadableStream) {
    Readable.fromWeb(body as never).pipe(request);
    return;
  }
  if (body instanceof Blob) {
    request.end(Buffer.from(await body.arrayBuffer()));
    return;
  }
  if (body instanceof URLSearchParams) {
    request.end(body.toString());
    return;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    request.end(Buffer.from(body instanceof ArrayBuffer ? body : body.buffer, body instanceof ArrayBuffer ? 0 : body.byteOffset, body instanceof ArrayBuffer ? undefined : body.byteLength));
    return;
  }
  request.end(String(body));
}

function limitResponseBody(response: Response): Response {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new Error("MCP response exceeded the configured size limit.");
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel("MCP response exceeded the configured size limit.");
        controller.error(new Error("MCP response exceeded the configured size limit."));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function normalizeDiscoveredTools(rawTools: unknown[]):
  | { ok: true; tools: McpDiscoveredTool[] }
  | { ok: false; message: string } {
  if (rawTools.length > MAX_DISCOVERED_TOOLS) {
    return { ok: false, message: "Server advertised too many MCP tools." };
  }
  const names = new Set<string>();
  const tools: McpDiscoveredTool[] = [];
  let totalSchemaBytes = 0;
  for (const rawTool of rawTools) {
    if (!rawTool || typeof rawTool !== "object") {
      return { ok: false, message: "Server advertised an invalid tool definition." };
    }
    const tool = rawTool as { name?: unknown; description?: unknown; inputSchema?: unknown };
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!/^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$/.test(name)) {
      return { ok: false, message: "Server advertised an invalid MCP tool name." };
    }
    if (names.has(name)) {
      return { ok: false, message: "Server advertised duplicate MCP tool names." };
    }
    const description = typeof tool.description === "string" ? tool.description : "";
    if (description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      return { ok: false, message: "Server advertised an MCP tool description that is too large." };
    }
    const rawSchema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema as Record<string, unknown>
      : {};
    const inputSchema = redactToolInputSchema(rawSchema);
    const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), "utf8");
    if (schemaBytes > MAX_TOOL_SCHEMA_BYTES || totalSchemaBytes + schemaBytes > MAX_DISCOVERY_SCHEMA_BYTES) {
      return { ok: false, message: "Server advertised MCP tool schemas that are too large." };
    }
    totalSchemaBytes += schemaBytes;
    names.add(name);
    tools.push({ name, description, inputSchema, inputSchemaDigest: digestSchema(inputSchema) });
  }
  return { ok: true, tools };
}

function guardEndpoint(connection: ResolvedMcpConnection): { ok: true } | { ok: false; code: McpErrorCode; message: string } {
  const check = validateMcpEndpoint(connection.endpoint, connection.allowedHosts);
  if (!check.ok) {
    return { ok: false, code: check.code ?? "mcp.policy_denied", message: check.message ?? "Endpoint rejected." };
  }
  return { ok: true };
}

function classifyError(error: unknown, secrets: Record<string, string> = {}): { code: McpErrorCode; safeMessage: string } {
  const message = redactKnownSecrets(redactMcpText(String((error as { message?: unknown })?.message ?? error)), secrets).slice(0, 240);
  const code = (error as { code?: unknown })?.code;
  const status = (error as { status?: unknown })?.status;
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "mcp.timeout", safeMessage: "Request to the MCP server timed out." };
  }
  if (status === 401 || status === 403 || code === 401 || code === 403 || /unauthorized|forbidden|401|403/i.test(message)) {
    return { code: "mcp.authentication_failed", safeMessage: "Authentication failed." };
  }
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || /fetch failed|network|connect|econn/i.test(message)) {
    return { code: "mcp.network_unreachable", safeMessage: "Could not reach the MCP server." };
  }
  return { code: "mcp.protocol_invalid", safeMessage: message || "Unexpected MCP protocol error." };
}

function summarizeContent(content: unknown, secrets: Record<string, string> = {}): string {
  return redactKnownSecrets(redactMcpText(typeof content === "string" ? content : JSON.stringify(content ?? "")), secrets).slice(0, 240);
}

function redactCallResult(content: unknown): unknown {
  // Tool results are not persisted by the bridge; this only softens what a caller logs.
  if (typeof content === "string") return redactMcpText(content);
  return content;
}

function redactKnownSecrets(message: string, secrets: Record<string, string>): string {
  let redacted = message;
  for (const value of Object.values(secrets)) {
    if (!value || value.length < 3) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function digestSchema(schema: Record<string, unknown>): string {
  try {
    return createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function safeProtocolVersion(client: Client): string | undefined {
  try {
    const value = (client as unknown as { getProtocolVersion?: () => string | undefined }).getProtocolVersion?.();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
