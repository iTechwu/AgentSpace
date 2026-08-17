import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTaskQueuePrisma } from "./task-queue-prisma-write.ts";

test("Prisma task queue write is idempotent by queue id and maps JSON payloads", async () => {
  let upsertArgs: Record<string, unknown> | undefined;
  const client = {
    agentTaskQueue: {
      upsert: async (args: Record<string, unknown>) => {
        upsertArgs = args;
        return {
          id: "queue-1",
          workspaceId: "workspace-1",
          agentId: "employee-1",
          employeeId: "employee-1",
          employeeName: "Employee",
          runtimeId: "runtime-1",
          triggerType: "workflow",
          priority: 4,
          status: "queued",
          inputJson: { taskId: "task-1" },
          queuedAt: new Date("2026-08-17T00:00:00.000Z"),
          createdAt: new Date("2026-08-17T00:00:00.000Z"),
          updatedAt: new Date("2026-08-17T00:00:00.000Z"),
        };
      },
    },
  };
  const task = await createAgentTaskQueuePrisma({
    id: "queue-1",
    workspaceId: "workspace-1",
    agentId: "employee-1",
    employeeId: "employee-1",
    employeeName: "Employee",
    runtimeId: "runtime-1",
    triggerType: "workflow",
    priority: 4,
    inputJson: '{"taskId":"task-1"}',
  }, client as never);
  assert.equal(upsertArgs?.where && (upsertArgs.where as Record<string, unknown>).id, "queue-1");
  assert.equal(task.inputJson, '{"taskId":"task-1"}');
  assert.equal(task.status, "queued");
});
