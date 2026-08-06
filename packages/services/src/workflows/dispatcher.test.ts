import assert from "node:assert/strict";
import test from "node:test";
import { dispatchReadyWorkflowNodeSync } from "./dispatcher.ts";

test("dispatcher rejects an unknown node run without creating a queue task", () => {
  assert.throws(
    () => dispatchReadyWorkflowNodeSync({ workspaceId: "missing-workspace", nodeRunId: "missing-node" }),
    /workflow_node_run_not_found|PostgreSQL database URL is required/,
  );
});
