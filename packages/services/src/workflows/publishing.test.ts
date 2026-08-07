import assert from "node:assert/strict";
import test from "node:test";
import { publishWorkflowSync } from "./publishing.ts";
import { hashWorkflowVersionContent } from "./validation.ts";

test("version content hash covers schemas and governance canonically", () => {
  const graph = {
    schemaVersion: 1 as const,
    nodes: [{ id: "approval", type: "approval" as const, config: {} }],
    edges: [],
  };
  const baseline = hashWorkflowVersionContent({
    graph,
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
    governance: { maxConcurrency: 2, budget: { currency: "CNY", amount: 10 } },
  });
  const reordered = hashWorkflowVersionContent({
    graph,
    inputSchema: { properties: { topic: { type: "string" } }, type: "object" },
    governance: { budget: { amount: 10, currency: "CNY" }, maxConcurrency: 2 },
  });
  const changedGovernance = hashWorkflowVersionContent({
    graph,
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
    governance: { maxConcurrency: 3, budget: { currency: "CNY", amount: 10 } },
  });

  assert.equal(reordered, baseline);
  assert.notEqual(changedGovernance, baseline);
});

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
