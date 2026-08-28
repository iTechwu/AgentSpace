import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelsUsageLogEntry } from "./models-usage-contract.ts";

test("normalizes models usage extensions without waiting for the published SDK type", () => {
  const normalized = normalizeModelsUsageLogEntry({
    id: "usage-1",
    requestId: "request-1",
    model: "claude-sonnet",
    vendor: "anthropic",
    protocol: "anthropic",
    requestPath: "/v1/messages",
    statusCode: 200,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    totalCost: "0.12",
    currency: "USD",
    isSuccess: true,
    timestamp: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-27T23:59:58.000Z",
    endedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:01:00.000Z",
    rootTaskId: " task-1 ",
  });

  assert.equal(normalized.cacheTokens, 40);
  assert.equal(normalized.startedAt, "2026-07-27T23:59:58.000Z");
  assert.equal(normalized.endedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(normalized.updatedAt, "2026-07-28T00:01:00.000Z");
  assert.equal(normalized.rootTaskId, " task-1 ");
});
