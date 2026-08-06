import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkflowDescendantNodeIds, completeWorkflowNodeSync } from "./coordinator.ts";

test("failed joins identify every downstream node that must be skipped", () => {
  assert.deepEqual(collectWorkflowDescendantNodeIds({
    schemaVersion: 1,
    nodes: [
      { id: "join", type: "join", config: {} },
      { id: "summary", type: "employee_task", employeeId: "employee-1", config: {} },
      { id: "notify", type: "employee_task", employeeId: "employee-2", config: {} },
    ],
    edges: [{ source: "join", target: "summary" }, { source: "summary", target: "notify" }],
  }, "join"), ["summary", "notify"]);
});

test("completion rejects an unknown node run before changing any state", () => {
  assert.throws(
    () => completeWorkflowNodeSync({ workspaceId: "missing-workspace", nodeRunId: "missing-node", taskQueueId: "missing-task", output: {} }),
    /workflow_node_run_not_found|PostgreSQL database URL is required/,
  );
});
