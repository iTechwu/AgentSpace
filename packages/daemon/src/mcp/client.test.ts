import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscoveredTools } from "./client.ts";

test("normalizeDiscoveredTools accepts bounded unique tool definitions", () => {
  const result = normalizeDiscoveredTools([
    { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" } },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]?.name, "search_repos");
  }
});

test("normalizeDiscoveredTools rejects duplicate names and oversized schemas", () => {
  const duplicate = normalizeDiscoveredTools([
    { name: "search", inputSchema: {} },
    { name: "search", inputSchema: {} },
  ]);
  assert.equal(duplicate.ok, false);

  const tooLarge = normalizeDiscoveredTools([
    { name: "search", inputSchema: { example: "x".repeat(16_385) } },
  ]);
  assert.equal(tooLarge.ok, false);
});
