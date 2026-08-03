import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedLookup, normalizeDiscoveredTools } from "./client.ts";

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

test("createPinnedLookup supports Node single-address and all-address callback shapes", async () => {
  const lookup = createPinnedLookup({ address: "203.0.113.10", family: 4 });

  const single = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
    lookup("mcp.example.test", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: "203.0.113.10", family: 4 });

  const all = await new Promise<unknown>((resolve, reject) => {
    lookup("mcp.example.test", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [{ address: "203.0.113.10", family: 4 }]);
});
