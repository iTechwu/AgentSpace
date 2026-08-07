import { describe, expect, it } from "vitest";
import {
  normalizeReconciledTaskCompletionTokenUsage,
  resolveReconciledConversationSessionId,
  resolveTaskCompletionSnapshotMetadata,
} from "./commit-reconciliation";

describe("commit reconciliation session recovery", () => {
  it("preserves an explicit non-reusable session marker", () => {
    expect(resolveReconciledConversationSessionId({
      snapshot: {
        provider: "hermes",
        sessionId: "provider-session",
        conversationSessionId: null,
      },
    })).toBeNull();
  });

  it("falls back using the persisted provider when the runtime row is unavailable", () => {
    expect(resolveReconciledConversationSessionId({
      snapshot: { provider: "hermes", sessionId: "provider-session" },
    })).toBeNull();
    expect(resolveReconciledConversationSessionId({
      snapshot: { provider: "codex", sessionId: "provider-session" },
    })).toBe("provider-session");
  });

  it("keeps all completion metadata pinned to the durable snapshot during replay", () => {
    expect(resolveTaskCompletionSnapshotMetadata({
      snapshot: {
        provider: "codex",
        sessionId: "original-session",
        conversationSessionId: "original-conversation",
        workDir: "/original/workdir",
      },
      runtimeProvider: "claude",
    })).toEqual({
      providerSessionId: "original-session",
      conversationSessionId: "original-conversation",
      workDir: "/original/workdir",
    });
  });

  it("normalizes positive token usage and rejects corrupt snapshots", () => {
    expect(normalizeReconciledTaskCompletionTokenUsage({
      modelId: " gpt-5 ",
      inputTokens: 10,
      outputTokens: 2,
      gatewayRequestId: " gateway-1 ",
    })).toEqual({ modelId: "gpt-5", inputTokens: 10, outputTokens: 2, gatewayRequestId: "gateway-1" });
    expect(normalizeReconciledTaskCompletionTokenUsage({ modelId: "gpt-5", inputTokens: -1, outputTokens: 2 })).toBeUndefined();
    expect(normalizeReconciledTaskCompletionTokenUsage({ modelId: "gpt-5", inputTokens: 1.5, outputTokens: 2 })).toBeUndefined();
    expect(normalizeReconciledTaskCompletionTokenUsage({ modelId: "gpt-5", inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});
