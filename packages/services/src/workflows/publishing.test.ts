import assert from "node:assert/strict";
import test from "node:test";
import { publishWorkflowSync } from "./publishing.ts";

test("publish rejects unavailable employees before writing a version", () => {
  assert.throws(
    () => publishWorkflowSync({
      workspaceId: "workflow-publish-test",
      workflowId: "workflow-missing-employee",
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: "start", type: "employee_task", employeeId: "missing-employee", config: {} },
          { id: "finish", type: "approval", config: {} },
        ],
        edges: [{ source: "start", target: "finish" }],
      },
      actor: { userId: "owner", displayName: "Owner", role: "owner" },
    }),
    /workflow_employee_not_ready|PostgreSQL database URL is required/,
  );
});
