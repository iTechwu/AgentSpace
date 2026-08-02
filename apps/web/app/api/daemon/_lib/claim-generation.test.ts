import { describe, expect, it } from "vitest";
import { parseClaimGenerationBody, parseClaimGenerationQuery } from "./claim-generation";

describe("daemon claim generation parsing", () => {
  it("accepts only a positive safe integer in JSON bodies", async () => {
    await expect(parseClaimGenerationBody(jsonRequest({ claimGeneration: 2 }))).resolves.toEqual({ ok: true, value: 2 });

    for (const claimGeneration of [undefined, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      const parsed = await parseClaimGenerationBody(jsonRequest({ claimGeneration }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.response.status).toBe(400);
      }
    }
  });

  it("returns 400 for malformed JSON", async () => {
    const parsed = await parseClaimGenerationBody(new Request("http://localhost", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.status).toBe(400);
      await expect(parsed.response.json()).resolves.toEqual({ error: "Request body must be valid JSON." });
    }
  });

  it("accepts a canonical decimal query value and rejects ambiguous forms", () => {
    expect(parseClaimGenerationQuery(new Request("http://localhost?claimGeneration=3"))).toEqual({ ok: true, value: 3 });
    for (const value of ["", "0", "-1", "1.5", "01", "+1", "9007199254740992"]) {
      const parsed = parseClaimGenerationQuery(new Request(`http://localhost?claimGeneration=${encodeURIComponent(value)}`));
      expect(parsed.ok).toBe(false);
    }
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
