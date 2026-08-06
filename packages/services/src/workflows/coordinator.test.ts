import assert from "node:assert/strict";
import test from "node:test";
import { completeWorkflowNodeSync } from "./coordinator.ts";

test("completion rejects an unknown node run before changing any state", () => {
  assert.throws(
    () => completeWorkflowNodeSync({ workspaceId: "missing-workspace", nodeRunId: "missing-node", taskQueueId: "missing-task", output: {} }),
    /workflow_node_run_not_found|PostgreSQL database URL is required/,
  );
});
