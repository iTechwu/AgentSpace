import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAllowedPath } from "./upstream-transport.ts";

test("allowed path prefix is matched on a segment boundary", () => {
  assert.equal(normalizeAllowedPath("/mcp", "/mcp"), "/mcp");
  assert.equal(normalizeAllowedPath("/mcp/sessions/1", "/mcp"), "/mcp/sessions/1");
  assert.equal(normalizeAllowedPath("/mcp-evil", "/mcp"), undefined);
  assert.equal(normalizeAllowedPath("/mcpx/sessions", "/mcp"), undefined);
});

test("absolute-form, network-path and query targets are denied", () => {
  assert.equal(normalizeAllowedPath("https://evil.example/mcp", "/mcp"), undefined);
  assert.equal(normalizeAllowedPath("//evil.example/mcp", "/mcp"), undefined);
  assert.equal(normalizeAllowedPath("/mcp?target=evil", "/mcp"), undefined);
});
