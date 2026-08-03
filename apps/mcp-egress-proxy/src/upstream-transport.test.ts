import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { armPinnedRequestTimeouts, isAllowedMcpContentType, normalizeAllowedPath } from "./upstream-transport.ts";

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

test("total request timeout remains armed after response headers until the body completes", async () => {
  class FakeRequest extends EventEmitter {
    destroyedWith: Error[] = [];

    destroy(error: Error): this {
      this.destroyedWith.push(error);
      this.emit("error", error);
      return this;
    }

    setTimeout(): this {
      return this;
    }
  }

  const timedOutRequest = new FakeRequest();
  const slowResponse = new EventEmitter();
  armPinnedRequestTimeouts(timedOutRequest as unknown as ClientRequest, {
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 10,
    idleTimeoutMs: 0,
  });
  timedOutRequest.emit("response", slowResponse);
  await delay(25);
  assert.match(timedOutRequest.destroyedWith[0]?.message ?? "", /Request timeout/);

  const completedRequest = new FakeRequest();
  const completedResponse = new EventEmitter();
  armPinnedRequestTimeouts(completedRequest as unknown as ClientRequest, {
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 10,
    idleTimeoutMs: 0,
  });
  completedRequest.emit("response", completedResponse);
  completedResponse.emit("end");
  await delay(25);
  assert.equal(completedRequest.destroyedWith.length, 0);
});
