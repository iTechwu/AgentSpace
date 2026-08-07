import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowDefinitionAuditInput,
  resolveWorkflowDefinitionDraftChanges,
} from "./definitions.ts";

test("definition audit records creation and draft updates with the acting user", () => {
  assert.deepEqual(buildWorkflowDefinitionAuditInput({
    action: "created",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    actorUserId: "user-1",
    occurredAt: "2026-08-07T00:00:00.000Z",
    changedFields: ["name", "ownerUserId", "graph"],
  }), {
    workspaceId: "workspace-1",
    title: "工作流已创建",
    note: "workflow-1",
    code: "workflow.definition.created",
    data: {
      workflowId: "workflow-1",
      actorUserId: "user-1",
      occurredAt: "2026-08-07T00:00:00.000Z",
      changedFields: ["name", "ownerUserId", "graph"],
    },
  });
  assert.equal(buildWorkflowDefinitionAuditInput({
    action: "updated",
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    actorUserId: "user-2",
    occurredAt: "2026-08-07T00:01:00.000Z",
    changedFields: ["channelName"],
  }).code, "workflow.definition.updated");
});

test("draft changes only report values that differ from the persisted definition", () => {
  const current = {
    name: "客户日报",
    description: "每日汇总",
    ownerUserId: "user-1",
    channelName: "运营群",
    draftGraphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
  };

  assert.deepEqual(resolveWorkflowDefinitionDraftChanges(current, {
    name: "客户日报",
    description: "每日汇总",
    ownerUserId: "user-1",
    channelName: "管理群",
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
  }), {
    name: "客户日报",
    description: "每日汇总",
    ownerUserId: "user-1",
    channelName: "管理群",
    graphJson: '{"edges":[],"nodes":[],"schemaVersion":1}',
    changedFields: ["channelName"],
  });

  assert.deepEqual(resolveWorkflowDefinitionDraftChanges(current, {
    name: "客户日报",
    description: "每日汇总",
    ownerUserId: "user-1",
    channelName: "运营群",
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
  }).changedFields, []);
});
