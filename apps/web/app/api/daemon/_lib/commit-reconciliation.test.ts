import { describe, expect, it } from "vitest";
import { resolveReconciledConversationSessionId } from "./commit-reconciliation";

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
});
