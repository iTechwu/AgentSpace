import type { McpEgressAuthMode } from "@dofe-agent/domain";

/**
 * Placeholder for Phase 3 OAuth token-broker client.
 *
 * In Phase 0-2 only `none` and `static_header` auth modes are used. OAuth
 * refresh tokens remain in the control-plane token vault; the proxy must never
 * hold long-lived OAuth credentials.
 */
export interface OAuthInjectionResult {
  headers: Record<string, string>;
}

export class OAuthInjector {
  async inject(authMode: McpEgressAuthMode, _grantReference: string | undefined): Promise<OAuthInjectionResult> {
    if (authMode === "oauth_proxy") {
      throw new Error("OAuth proxy injection is not implemented in Phase 0-2.");
    }
    return { headers: {} };
  }
}
