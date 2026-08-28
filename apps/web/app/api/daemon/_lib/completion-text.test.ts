import { describe, expect, it } from "vitest";
import { resolveTaskCompletionText } from "./completion-text";

describe("resolveTaskCompletionText", () => {
  it("does not duplicate a final response when streamed text only differs by trailing whitespace", () => {
    expect(resolveTaskCompletionText("hello from claude\n", "hello from claude")).toBeUndefined();
  });

  it("keeps a non-prefix final response authoritative without appending it to streamed text", () => {
    expect(resolveTaskCompletionText("draft response", "revised final response")).toBeUndefined();
  });

  it("appends only the missing suffix when the stream is an exact prefix", () => {
    expect(resolveTaskCompletionText("hello ", "hello from claude")).toBe("from claude");
  });

  it("persists the final response for legacy runs without streamed text", () => {
    expect(resolveTaskCompletionText("", "hello from claude")).toBe("hello from claude");
  });
});
