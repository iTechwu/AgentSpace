import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedMcpContentType, normalizeAllowedPath } from "./upstream-transport.ts";

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

test("root prefix allows paths while preserving request-target restrictions", () => {
  assert.equal(normalizeAllowedPath("/mcp/sessions", "/"), "/mcp/sessions");
});

test("MCP content types are parsed as exact media types", () => {
  assert.equal(isAllowedMcpContentType("application/json"), true);
  assert.equal(isAllowedMcpContentType("Application/JSON; charset=utf-8"), true);
  assert.equal(isAllowedMcpContentType("text/event-stream; charset=utf-8"), true);
  assert.equal(isAllowedMcpContentType("application/jsonevil"), false);
  assert.equal(isAllowedMcpContentType(""), false);
});
