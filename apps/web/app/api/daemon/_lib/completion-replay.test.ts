import { describe, expect, it } from "vitest";
import {
  resolveManagedTaskUsageGatewayRequestId,
  shouldPersistManagedTaskUsages,
} from "./completion-replay";
import { persistManagedTaskUsagesBestEffort } from "../tasks/[taskId]/complete/route";

describe("completion replay usage boundary", () => {
  it("does not replay request-body usage during preparing-commit recovery", () => {
    expect(shouldPersistManagedTaskUsages({
      taskStatus: "preparing_commit",
      runtimeMode: "remote",
      hasManagedCredential: true,
    })).toBe(false);
    expect(shouldPersistManagedTaskUsages({
      taskStatus: "running",
      runtimeMode: "remote",
      hasManagedCredential: true,
    })).toBe(true);
  });

  it("supplies a stable task-level key when the gateway omits its request id", () => {
    expect(resolveManagedTaskUsageGatewayRequestId({
      taskId: "task-1",
      usageIndex: 2,
    })).toBe("task:task-1:usage:2");
    expect(resolveManagedTaskUsageGatewayRequestId({
      taskId: "task-1",
      usageIndex: 2,
      gatewayUsageId: " gateway-usage-1 ",
    })).toBe("gateway-usage:gateway-usage-1");
    expect(resolveManagedTaskUsageGatewayRequestId({
      taskId: "task-1",
      usageIndex: 2,
      gatewayRequestId: " gateway-1 ",
      gatewayUsageId: "gateway-usage-1",
    })).toBe("gateway-1");
  });

  it("uses the stable fallback in managed usage persistence", () => {
    const records: Array<{ gatewayRequestId?: string }> = [];
    const input = {
      usages: [{
        modelId: "gpt-5",
        runtimeCredentialId: "credential-1",
        inputTokens: 10,
        outputTokens: 2,
      }],
      workspaceId: "workspace-1",
      taskId: "task-1",
      agentId: "agent-1",
      runtimeCredentialId: "credential-1",
      recordUsage: (record: { gatewayRequestId?: string }) => {
        records.push(record);
        return {} as never;
      },
    };

    persistManagedTaskUsagesBestEffort(input);
    persistManagedTaskUsagesBestEffort(input);

    expect(records.map((record) => record.gatewayRequestId)).toEqual([
      "task:task-1:usage:0",
      "task:task-1:usage:0",
    ]);
  });
});
