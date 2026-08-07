import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowDefinitionAuditInput } from "./definitions.ts";

test("definition audit records creation and draft updates with the acting user", () => {
  assert.deepEqual(buildWorkflowDefinitionAuditInput({
    action: "created",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    actorUserId: "user-1",
    occurredAt: "2026-08-07T00:00:00.000Z",
  }), {
    workspaceId: "workspace-1",
    title: "工作流已创建",
    note: "workflow-1",
    code: "workflow.definition.created",
    data: {
      workflowId: "workflow-1",
      actorUserId: "user-1",
      occurredAt: "2026-08-07T00:00:00.000Z",
    },
  });
  assert.equal(buildWorkflowDefinitionAuditInput({
    action: "updated",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    actorUserId: "user-2",
    occurredAt: "2026-08-07T00:01:00.000Z",
  }).code, "workflow.definition.updated");
});
