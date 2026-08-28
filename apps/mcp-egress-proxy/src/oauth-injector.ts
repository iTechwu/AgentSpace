import type { McpEgressAuthMode } from "@dofe-agent/domain";

/**
 * OAuth refresh tokens remain in the control-plane token vault. The proxy sends
 * only an opaque grant reference to the broker and receives a short-lived token.
 */
export interface OAuthInjectionResult {
  headers: Record<string, string>;
}

export interface OAuthInjectionContext {
  workspaceId: string;
  runtimeId: string;
  connectionId: string;
  taskId?: string;
  operationId?: string;
}

export interface OAuthInjectorOptions {
  brokerUrl?: string;
  brokerToken?: string;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
}

export class OAuthInjector {
  private readonly brokerUrl?: URL;
  private readonly brokerToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OAuthInjectorOptions = {}) {
    this.brokerUrl = parseBrokerUrl(options.brokerUrl, options.allowInsecureHttp === true);
    this.brokerToken = options.brokerToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async inject(
    authMode: McpEgressAuthMode,
    grantReference: string | undefined,
    context?: OAuthInjectionContext,
  ): Promise<OAuthInjectionResult> {
    if (authMode !== "oauth_proxy") return { headers: {} };
    if (!this.brokerUrl || !this.brokerToken || !grantReference?.trim() || !context) {
      throw new Error("OAuth broker configuration or grant reference is unavailable.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetchImpl(new URL("/v1/mcp/oauth/token", this.brokerUrl), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.brokerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ grantReference: grantReference.trim(), ...context }),
      });
      if (!response.ok) throw new Error("OAuth broker rejected the token request.");
      const rawBody = await response.text();
      if (Buffer.byteLength(rawBody, "utf8") > 16_384) {
        throw new Error("OAuth broker returned an invalid short-lived token.");
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new Error("OAuth broker returned an invalid short-lived token.");
      }
      const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      const tokenType = typeof body.tokenType === "string" ? body.tokenType.trim() : "Bearer";
      const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : undefined;
      if (!accessToken || !/^[A-Za-z][A-Za-z0-9._~-]{0,31}$/.test(tokenType) || !expiresIn || expiresIn <= 0 || expiresIn > 3600) {
        throw new Error("OAuth broker returned an invalid short-lived token.");
      }
      return { headers: { Authorization: `${tokenType} ${accessToken}` } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBrokerUrl(value: string | undefined, allowInsecureHttp: boolean): URL | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const url = new URL(candidate);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:"))) {
    throw new Error("MCP OAuth broker URL is invalid.");
  }
  return url;
}
