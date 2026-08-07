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
  const createdAuditData = JSON.parse(listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.created" })[0]!.dataJson) as Record<string, unknown>;
  assert.equal(createdAuditData.actorUserId, "u1");
  const updateAuditData = JSON.parse(listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.updated" })[0]!.dataJson) as Record<string, unknown>;
  assert.equal(updateAuditData.actorUserId, "u2");
  assert.deepEqual(updateAuditData.changedFields, ["graph"]);
  assert.throws(
    () => updateWorkflowDraftSync({
      id: draft.id,
      workspaceId: WORKSPACE_ID,
      expectedDraftVersion: draft.draftVersion,
      name: "Stale change",
      updatedBy: "u2",
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

test("no-op draft update with shuffled graph keys does not bump version or write audit", () => {
  const draft = createWorkflowDefinitionSync({
    id: "workflow-draft-noop-test",
    workspaceId: WORKSPACE_ID,
    name: "No-op update",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const auditCountBefore = listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.updated" })
    .filter((audit) => {
      const data = JSON.parse(audit.dataJson) as Record<string, unknown>;
      return data.workflowId === draft.id;
    }).length;
  // Send the same graph with keys in a different order.
  const unchanged = updateWorkflowDraftSync({
    id: draft.id,
    workspaceId: WORKSPACE_ID,
    expectedDraftVersion: draft.draftVersion,
    graphJson: '{"edges":[],"schemaVersion":1,"nodes":[]}',
    updatedBy: "u1",
  });
  assert.equal(unchanged.draftVersion, draft.draftVersion, "draft version must not bump on no-op");
  assert.equal(
    listAuditLogsSync(WORKSPACE_ID, { code: "workflow.definition.updated" })
      .filter((audit) => {
        const data = JSON.parse(audit.dataJson) as Record<string, unknown>;
        return data.workflowId === draft.id;
      }).length,
    auditCountBefore,
    "no updated audit must be written for no-op",
  );
});

test("workflow definition audit can be retrieved by actorUserId", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-audit-actor-test",
    workspaceId: WORKSPACE_ID,
    name: "Audit actor",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const byActorUserId = listAuditLogsSync(WORKSPACE_ID, {
    code: "workflow.definition.created",
    actorId: "u1",
  });
  assert.ok(byActorUserId.some((audit) => {
    const data = JSON.parse(audit.dataJson) as Record<string, unknown>;
    return data.workflowId === definition.id && data.actorUserId === "u1";
  }), "audit must be searchable by actorUserId");
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

test("trigger publish is idempotent and records an audit only on a real change", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-trigger-only-audit-test",
    workspaceId: WORKSPACE_ID,
    name: "Trigger only",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const graphJson = '{"schemaVersion":1,"nodes":[],"edges":[]}';
  const manualTrigger = { type: "manual" as const, configJson: "{}", status: "active" as const };
  const triggerRowCount = () => (getDatabase().prepare(
    "SELECT count(*) AS n FROM workflow_trigger WHERE workspace_id = ? AND workflow_id = ?",
  ).get(WORKSPACE_ID, definition.id) as { n: number }).n;
  const triggerAuditCount = () => listAuditLogsSync(WORKSPACE_ID, { code: "workflow.trigger.published" }).length;
  const triggerOutboxCount = () => (getDatabase().prepare(
    "SELECT count(*) AS n FROM workflow_outbox WHERE workspace_id = ? AND event_type = 'workflow.trigger.published'",
  ).get(WORKSPACE_ID) as { n: number }).n;

  // First publish with a manual trigger → one trigger row + one audit.
  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:trigger-only-a",
    publishedBy: "u1",
    trigger: manualTrigger,
  });
  assert.equal(triggerRowCount(), 1, "exactly one trigger row after first publish");
  assert.equal(triggerAuditCount(), 1, "one trigger.published audit after first publish");
  assert.equal(triggerOutboxCount(), 0, "no hollow trigger.published outbox row");

  // Identical republish with the SAME trigger → idempotent: no new audit, still one row.
  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:trigger-only-a",
    publishedBy: "u1",
    trigger: manualTrigger,
  });
  assert.equal(triggerRowCount(), 1, "still one trigger row after identical republish");
  assert.equal(triggerAuditCount(), 1, "no duplicate audit on identical republish");

  // Identical content but trigger changes manual → schedule → one new audit, single row reused.
  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:trigger-only-a",
    publishedBy: "u1",
    trigger: {
      type: "schedule",
      configJson: '{"repeatSeconds":3600}',
      nextFireAt: "2026-08-09T00:00:00.000Z",
      status: "active",
    },
  });
  assert.equal(triggerRowCount(), 1, "single trigger row reused when type changes");
  assert.equal(triggerAuditCount(), 2, "one new audit only when the trigger actually changes");
  assert.equal(triggerOutboxCount(), 0, "still no hollow outbox row");

  const latest = listAuditLogsSync(WORKSPACE_ID, { code: "workflow.trigger.published" })[0]!;
  const data = JSON.parse(latest.dataJson) as Record<string, unknown>;
  assert.equal(data.workflowId, definition.id);
  assert.equal(data.triggerType, "schedule");
  assert.equal(data.actorUserId, "u1");
});

test("schedule trigger republish preserves nextFireAt and runtime lease state", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-schedule-trigger-idempotent-test",
    workspaceId: WORKSPACE_ID,
    name: "Schedule idempotent",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const graphJson = '{"schemaVersion":1,"nodes":[],"edges":[]}';
  const scheduleTrigger = {
    type: "schedule" as const,
    configJson: '{"repeatSeconds":3600}',
    status: "active" as const,
  };

  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:schedule-a",
    publishedBy: "u1",
    trigger: scheduleTrigger,
  });
  const first = readWorkflowTriggerForWorkflowSync(definition.id, WORKSPACE_ID)!;
  const firstNextFireAt = first.nextFireAt;

  // Simulate the scheduler having claimed the trigger and recorded a fire time.
  getDatabase().prepare(
    "UPDATE workflow_trigger SET lease_owner = ?, lease_expires_at = ?, last_fire_at = ? WHERE id = ?",
  ).run("scheduler-1", "2026-08-10T00:00:00.000Z", "2026-08-09T00:00:00.000Z", first.id);

  // Identical schedule republish must not drift nextFireAt and must preserve lease state.
  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:schedule-a",
    publishedBy: "u1",
    trigger: scheduleTrigger,
  });
  const after = readWorkflowTriggerForWorkflowSync(definition.id, WORKSPACE_ID)!;
  assert.equal(after.id, first.id);
  assert.equal(after.nextFireAt, firstNextFireAt, "nextFireAt must not drift on identical schedule republish");
  assert.equal(after.leaseOwner, "scheduler-1", "lease_owner must be preserved");
  assert.equal(after.leaseExpiresAt, "2026-08-10T00:00:00.000Z", "lease_expires_at must be preserved");
  assert.equal(after.lastFireAt, "2026-08-09T00:00:00.000Z", "last_fire_at must be preserved");

  const auditCountForWorkflow = () =>
    listAuditLogsSync(WORKSPACE_ID, { code: "workflow.trigger.published" })
      .filter((audit) => {
        const data = JSON.parse(audit.dataJson) as Record<string, unknown>;
        return data.workflowId === definition.id;
      }).length;
  assert.equal(auditCountForWorkflow(), 1, "identical schedule republish must not create a new audit");
});

test("workflow_trigger enforces a single row per workspace and workflow", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-trigger-unique-constraint-test",
    workspaceId: WORKSPACE_ID,
    name: "Unique trigger",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO workflow_trigger
       (id, workspace_id, workflow_id, type, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?)`,
  ).run("workflow-trigger-unique-a", WORKSPACE_ID, definition.id, now, now);
  assert.throws(
    () => getDatabase().prepare(
      `INSERT INTO workflow_trigger
         (id, workspace_id, workflow_id, type, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?)`,
    ).run("workflow-trigger-unique-b", WORKSPACE_ID, definition.id, now, now),
    /workflow_trigger_workspace_workflow_unique/,
  );
});

test("publishing with a stale draft version is rejected inside the transaction", () => {
  const definition = createWorkflowDefinitionSync({
    id: "workflow-publish-cas-test",
    workspaceId: WORKSPACE_ID,
    name: "CAS publish",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const baseline = definition.draftVersion;
  const graphJson = '{"schemaVersion":1,"nodes":[],"edges":[]}';
  // First publish with the matching expected draft version succeeds.
  publishWorkflowVersionSync({
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson,
    contentHash: "sha256:cas-a",
    publishedBy: "u1",
    expectedDraftVersion: baseline,
  });
  // A concurrent edit bumps the draft version after the pre-check window.
  const updated = updateWorkflowDraftSync({
    id: definition.id,
    workspaceId: WORKSPACE_ID,
    expectedDraftVersion: baseline,
    name: "CAS rename",
    updatedBy: "u2",
  });
  assert.equal(updated.draftVersion, baseline + 1);
  // Publishing the stale draft revision must now be rejected in-transaction.
  assert.throws(
    () => publishWorkflowVersionSync({
      workspaceId: WORKSPACE_ID,
      workflowId: definition.id,
      graphJson,
      contentHash: "sha256:cas-a",
      publishedBy: "u1",
      expectedDraftVersion: baseline,
    }),
    /workflow_draft_version_conflict/,
  );
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
