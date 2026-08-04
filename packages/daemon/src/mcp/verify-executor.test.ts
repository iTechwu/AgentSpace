import assert from "node:assert/strict";
import test from "node:test";
import type { ClaimedMcpConnectionOperation, RuntimeMcpClient } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import { executeMcpConnectionOperation } from "./verify-executor.ts";

test("executeMcpConnectionOperation reports verification stages in order", async () => {
  const events: string[] = [];
  const client = {
    startMcpConnectionOperation: async () => {
      events.push("connecting");
    },
    updateMcpConnectionOperationStage: async (_operationId: string, input: { stage: string }) => {
      events.push(input.stage);
    },
    completeMcpConnectionOperation: async () => {
      events.push("completed");
    },
    failMcpConnectionOperation: async () => {
      assert.fail("operation should not fail");
    },
  } as unknown as HttpDaemonClient;
  const operation: ClaimedMcpConnectionOperation = {
    id: "operation-1",
    workspaceId: "workspace-1",
    runtimeId: "runtime-1",
    connectionId: "connection-1",
    operation: "verify",
    source: "user_verify",
    status: "claimed",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    allowedHosts: ["mcp.example.test"],
    approvedTools: [],
    declaredTools: [],
    secrets: {},
    nonSecretParams: {},
    createdAt: "2026-08-05T00:00:00.000Z",
  };

  await executeMcpConnectionOperation(client, operation, {
    createClient: (onStage): RuntimeMcpClient => ({
      verify: async () => {
        await onStage("negotiating");
        await onStage("discovering_tools");
        return {
          status: "ready",
          protocolVersion: "2025-06-18",
          discoveredTools: [],
          toolsFingerprint: "",
          latencyMs: 10,
        };
      },
      call: async () => ({ ok: true, result: null }),
    }),
  });

  assert.deepEqual(events, ["connecting", "negotiating", "discovering_tools", "finalizing", "completed"]);
});
