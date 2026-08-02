import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpAuditOutbox } from "./audit-outbox.ts";

const audit = {
  taskId: "task-1",
  connectionId: "connection-1",
  toolName: "search",
  outcome: "succeeded" as const,
  eventId: "event-1",
};

test("MCP audit outbox survives a failed delivery and replays after restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-mcp-audit-outbox-"));
  try {
    const firstProcess = new McpAuditOutbox(stateDir);
    firstProcess.enqueue(audit);
    const failed = await firstProcess.flush({
      reportMcpToolAudits: async () => {
        throw new Error("network unavailable");
      },
    });
    assert.deepEqual(failed, { attempted: 1, delivered: 0, failed: 1, deadLettered: 0 });
    assert.equal(listPending(stateDir).length, 1);

    const deliveredEventIds: string[] = [];
    const restartedProcess = new McpAuditOutbox(stateDir);
    const replayed = await restartedProcess.flush({
      reportMcpToolAudits: async (_taskId, audits) => {
        deliveredEventIds.push(...audits.map((item) => item.eventId));
      },
    });
    assert.deepEqual(replayed, { attempted: 1, delivered: 1, failed: 0, deadLettered: 0 });
    assert.deepEqual(deliveredEventIds, ["event-1"]);
    assert.equal(listPending(stateDir).length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("MCP audit outbox deduplicates repeated enqueue by event id", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-mcp-audit-outbox-"));
  try {
    const outbox = new McpAuditOutbox(stateDir);
    outbox.enqueue(audit);
    outbox.enqueue({ ...audit, safeSummary: "retry" });
    assert.equal(listPending(stateDir).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function listPending(stateDir: string): string[] {
  return readdirSync(join(stateDir, "mcp-audit-outbox")).filter((name) => name.endsWith(".json"));
}
