import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import { listAuditLogsSync } from "../audit-log.ts";
import {
  createWorkflowDefinitionSync,
  pauseWorkflowTriggersForDefinitionSync,
  publishWorkflowVersionSync,
  readWorkflowDefinitionSync,
  readWorkflowTriggerForWorkflowSync,
  readWorkflowVersionSync,
  transitionWorkflowDefinitionStatusSync,
  updateWorkflowDraftSync,
  upsertWorkflowTriggerSync,
} from "./definitions.ts";

const WORKSPACE_ID = "workflow-repository-test";
const OTHER_WORKSPACE_ID = "workflow-repository-other-test";

before(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const id of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run(id, id, id, now, now);
  }
});

after(() => {
  getDatabase().prepare("DELETE FROM workspace WHERE id IN (?, ?)")
    .run(WORKSPACE_ID, OTHER_WORKSPACE_ID);
  resetDatabaseForTests();
});

test("published versions are immutable and scoped to workspace", () => {
  const draft = createWorkflowDefinitionSync({
    id: "workflow-definition-test",
    workspaceId: WORKSPACE_ID,
    name: "Daily brief",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const version = publishWorkflowVersionSync({
    id: "workflow-version-test",
    workspaceId: WORKSPACE_ID,
    workflowId: draft.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:a",
    publishedBy: "u1",
  });

  assert.equal(readWorkflowDefinitionSync(draft.id, OTHER_WORKSPACE_ID), null);
  assert.equal(readWorkflowVersionSync(version.id, OTHER_WORKSPACE_ID), null);
  assert.throws(
    () => publishWorkflowVersionSync({
      workspaceId: WORKSPACE_ID,
      workflowId: draft.id,
      graphJson: '{"schemaVersion":1,"nodes":[{}],"edges":[]}',
      contentHash: "sha256:b",
      publishedBy: "u1",
      versionNumber: version.versionNumber,
    }),
    /workflow_version_conflict/,
  );
  const changedDraft = updateWorkflowDraftSync({
    id: draft.id,
    workspaceId: WORKSPACE_ID,
    expectedDraftVersion: draft.draftVersion,
    graphJson: '{"schemaVersion":1,"nodes":[{"id":"next"}],"edges":[]}',
    updatedBy: "u2",
  });
  assert.equal(changedDraft.draftVersion, draft.draftVersion + 1);
  assert.equal(readWorkflowVersionSync(version.id, WORKSPACE_ID)?.graphJson, version.graphJson);
  assert.equal(listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.created" })[0]?.dataJson.includes('"actorUserId":"u1"'), true);
  assert.equal(listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.updated" })[0]?.dataJson.includes('"actorUserId":"u2"'), true);
  assert.throws(
    () => updateWorkflowDraftSync({
      id: draft.id,
      workspaceId: WORKSPACE_ID,
      expectedDraftVersion: draft.draftVersion,
      name: "Stale change",
    }),
    /workflow_draft_version_conflict/,
  );

  const identical = publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: draft.id,
    graphJson: version.graphJson,
    contentHash: version.contentHash,
    publishedBy: "u1",
  });
  assert.equal(identical.id, version.id);
});

test("trigger upsert cannot overwrite a trigger from another workspace", () => {
  const local = createWorkflowDefinitionSync({
    id: "workflow-trigger-definition-test",
    workspaceId: WORKSPACE_ID,
    name: "Local",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const other = createWorkflowDefinitionSync({
    id: "workflow-trigger-other-definition-test",
    workspaceId: OTHER_WORKSPACE_ID,
    name: "Other",
    ownerUserId: "u2",
    createdBy: "u2",
  });
  const trigger = upsertWorkflowTriggerSync({
    id: "workflow-trigger-test",
    workspaceId: WORKSPACE_ID,
    workflowId: local.id,
    type: "manual",
    configJson: "{}",
  });
  assert.equal(readWorkflowTriggerForWorkflowSync(local.id, WORKSPACE_ID)?.id, trigger.id);

  assert.throws(
    () => upsertWorkflowTriggerSync({
      id: trigger.id,
      workspaceId: OTHER_WORKSPACE_ID,
      workflowId: other.id,
      type: "event",
      configJson: '{"event":"changed"}',
    }),
    /workflow_trigger_cross_workspace_conflict/,
  );
});

test("publishing historical content reactivates its immutable version", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-version-reactivation-test",
    workspaceId: WORKSPACE_ID,
    name: "Version reactivation",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const first = publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:reactivation-a",
    publishedBy: "u1",
  });
  const second = publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[{"id":"next","type":"approval","config":{}}],"edges":[]}',
    contentHash: "sha256:reactivation-b",
    publishedBy: "u1",
  });
  assert.equal(readWorkflowDefinitionSync(definition.id, WORKSPACE_ID)?.activeVersionId, second.id);

  const reactivated = publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: first.graphJson,
    contentHash: first.contentHash,
    publishedBy: "u1",
  });

  assert.equal(reactivated.id, first.id);
  assert.equal(readWorkflowDefinitionSync(definition.id, WORKSPACE_ID)?.activeVersionId, first.id);
});

test("republishing a paused workflow preserves its definition and trigger suspension", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-paused-republish-test",
    workspaceId: WORKSPACE_ID,
    name: "Paused republish",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const trigger = {
    id: "workflow-paused-trigger-test",
    type: "schedule" as const,
    configJson: '{"repeatSeconds":3600}',
    nextFireAt: "2026-08-08T00:00:00.000Z",
    status: "active",
  };
  const first = publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:paused-a",
    publishedBy: "u1",
    trigger,
  });
  transitionWorkflowDefinitionStatusSync({
    id: definition.id,
    workspaceId: WORKSPACE_ID,
    from: ["published"],
    to: "paused",
  });
  pauseWorkflowTriggersForDefinitionSync({ workflowId: definition.id, workspaceId: WORKSPACE_ID });

  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[{"id":"approval","type":"approval","config":{}}],"edges":[]}',
    contentHash: "sha256:paused-b",
    publishedBy: "u1",
    trigger,
  });
  assert.equal(readWorkflowDefinitionSync(definition.id, WORKSPACE_ID)?.status, "paused");
  assert.equal(readWorkflowTriggerForWorkflowSync(definition.id, WORKSPACE_ID)?.status, "suspended");

  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: first.graphJson,
    contentHash: first.contentHash,
    publishedBy: "u1",
    trigger,
  });
  assert.equal(readWorkflowDefinitionSync(definition.id, WORKSPACE_ID)?.status, "paused");
  assert.equal(readWorkflowTriggerForWorkflowSync(definition.id, WORKSPACE_ID)?.status, "suspended");
});
