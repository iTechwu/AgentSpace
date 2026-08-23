import { describe, expect, it } from "vitest";
import { normalizeRuntimeProviderHealth } from "./runtime-health.ts";

describe("runtime health", () => {
  it("separates runtime online from broken provider usability", () => {
    const health = normalizeRuntimeProviderHealth({
      runtimeStatus: "online",
      runtimeMetadata: {
        providerHealth: {
          status: "broken",
          reason: "Authentication failed.",
          checkedAt: "2026-04-30T08:00:00.000Z",
          error: {
            code: "provider.auth_invalid",
            message: "Token expired.",
          },
        },
      },
      lastError: "exited with code 1",
    });

    expect(health.runtimeStatus).toBe("online");
    expect(health.providerHealth).toBe("broken");
    expect(health.providerUsable).toBe("unusable");
    expect(health.lastProviderErrorCode).toBe("provider.auth_invalid");
    expect(health.lastProviderErrorMessage).toBe("Token expired.");
    expect(health.providerHealthReason).toBe("Authentication failed.");
    expect(health.lastHealthCheckedAt).toBe("2026-04-30T08:00:00.000Z");
  });

  it("keeps online runtime usability unverified when no provider probe is recorded", () => {
    const health = normalizeRuntimeProviderHealth({
      runtimeStatus: "online",
      runtimeMetadata: {},
    });

    expect(health.providerHealth).toBe("unknown");
    expect(health.providerUsable).toBe("unverified");
    expect(health.providerHealthReason).toBe("Provider health has not been checked yet.");
  });

  it("redacts credential-shaped values from provider health diagnostics", () => {
    const health = normalizeRuntimeProviderHealth({
      runtimeStatus: "online",
      runtimeMetadata: {
        providerHealth: {
          status: "broken",
          reason: "request failed authorization=Bearer secret-token-123",
          error: {
            code: "provider.auth_invalid",
            message: "DEEPSEEK_API_KEY=sk-secret-value",
          },
        },
      },
    });

    expect(health.providerHealthReason).toContain("authorization=Bearer [REDACTED]");
    expect(health.lastProviderErrorMessage).toBe("DEEPSEEK_API_KEY=[REDACTED]");
    expect(JSON.stringify(health)).not.toContain("secret-token-123");
    expect(JSON.stringify(health)).not.toContain("sk-secret-value");
  });
});
