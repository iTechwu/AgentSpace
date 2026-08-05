import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import {
  createOpenMontageJobLinkSync,
  ingestOpenMontageJobEventSync,
  listOpenMontageNotificationOutboxSync,
  readOpenMontageChatBindingSync,
  readOpenMontageJobProjectionSync,
} from "./openmontage-jobs.ts";
import { getDatabase } from "./database.ts";
import { parseOpenMontageJobEvent, type OpenMontageJobEvent } from "@dofe-agent/domain";

before(() => {
  process.env.NODE_ENV = "test";
});

function clearOpenMontageTables(): void {
  getDatabase().exec(`
    DELETE FROM openmontage_notification_outbox;
    DELETE FROM openmontage_event_nonce;
    DELETE FROM openmontage_chat_binding;
    DELETE FROM openmontage_job_event;
    DELETE FROM openmontage_job_projection;
    DELETE FROM openmontage_job_link;
  `);
}

beforeEach(() => {
  clearOpenMontageTables();
});

after(() => {
  clearOpenMontageTables();
});

function snapshot() {
  return {
    schemaVersion: 1 as const,
    jobId: "om_job_1",
    status: "QUEUED" as const,
    workflow: {
      name: "animated-explainer",
      version: "2.0",
      stages: [
        { code: "research", labelCode: "openmontage.stage.research", approvalRequired: false },
        { code: "proposal", labelCode: "openmontage.stage.proposal", approvalRequired: true },
      ],
    },
    stages: [
      {
        code: "research",
        labelCode: "openmontage.stage.research",
        approvalRequired: false,
        approvalStatus: "NOT_REQUIRED" as const,
        status: "PENDING" as const,
        attempt: 0,
      },
      {
        code: "proposal",
        labelCode: "openmontage.stage.proposal",
        approvalRequired: true,
        approvalStatus: "REQUIRED" as const,
        status: "PENDING" as const,
        attempt: 0,
      },
    ],
    currentStage: null,
    lastSequence: 1,
    createdAt: "2026-08-05T10:00:01Z",
    updatedAt: "2026-08-05T10:00:01Z",
  };
}

function createLink(overrides: Record<string, unknown> = {}) {
  return createOpenMontageJobLinkSync({
    workspaceId: "default",
    employeeId: "employee-1",
    runtimeId: "runtime-1",
    rootTaskId: "task-1",
    conversationId: "conversation-1",
    sourceInvocationId: "invocation-1",
    traceId: "trace-1",
    channelName: "direct:employee-1",
    conversationMessageId: "message-1",
    snapshot: snapshot(),
    ...overrides,
  });
}

function event(
  sequence: number,
  eventType: OpenMontageJobEvent["eventType"],
  payload: Record<string, unknown>,
): OpenMontageJobEvent {
  return parseOpenMontageJobEvent({
    schemaVersion: 1,
    eventId: `om_evt_${sequence}`,
    eventType,
    occurredAt: `2026-08-05T10:00:0${sequence}Z`,
    jobId: "om_job_1",
    sequence,
    workspaceId: "default",
    employeeId: "employee-1",
    runtimeId: "runtime-1",
    rootTaskId: "task-1",
    conversationId: "conversation-1",
    sourceInvocationId: "invocation-1",
    traceId: "trace-1",
    payload,
  });
}

test("Job Link stores immutable attribution, initial projection, and chat binding", () => {
  const link = createLink();
  const projection = readOpenMontageJobProjectionSync("default", "om_job_1");
  const binding = readOpenMontageChatBindingSync("default", "om_job_1");

  assert.equal(link.employeeId, "employee-1");
  assert.equal(link.workflowVersion, "2.0");
  assert.equal(projection?.lastAppliedSequence, 1);
  assert.equal(projection?.stages[1]?.approvalRequired, true);
  assert.equal(binding?.channelName, "direct:employee-1");

  assert.throws(
    () => createLink({ employeeId: "employee-2" }),
    /immutable attribution/,
  );
  assert.throws(
    () => createLink({ channelName: "direct:employee-2" }),
    /chat binding/,
  );
});

test("event inbox deduplicates events and rejects attribution changes", () => {
  createLink();
  const started = event(2, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  });

  assert.equal(ingestOpenMontageJobEventSync(started, { nonce: "nonce-1" }).outcome, "applied");
  assert.equal(ingestOpenMontageJobEventSync(started, { nonce: "nonce-2" }).outcome, "duplicate");
  assert.equal(readOpenMontageJobProjectionSync("default", "om_job_1")?.currentStage, "research");

  assert.throws(
    () => ingestOpenMontageJobEventSync(
      { ...started, eventId: "om_evt_wrong", sequence: 3, employeeId: "employee-2" },
      { nonce: "nonce-3" },
    ),
    /attribution/,
  );
});

test("out-of-order events remain pending until the missing sequence arrives", () => {
  createLink();
  const completed = event(3, "openmontage.stage.completed", {
    stage: "research",
    stageAttempt: 1,
    status: "SUCCEEDED",
    approvalStatus: "NOT_REQUIRED",
  });
  const started = event(2, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  });

  const gap = ingestOpenMontageJobEventSync(completed, { nonce: "nonce-gap" });
  assert.equal(gap.outcome, "gap");
  assert.equal(gap.projection.syncStatus, "SYNCING");
  assert.equal(gap.projection.lastAppliedSequence, 1);

  const reconciled = ingestOpenMontageJobEventSync(started, { nonce: "nonce-start" });
  assert.equal(reconciled.outcome, "applied");
  assert.equal(reconciled.projection.syncStatus, "CURRENT");
  assert.equal(reconciled.projection.lastAppliedSequence, 3);
  assert.equal(reconciled.projection.stages[0]?.status, "SUCCEEDED");
  assert.equal(listOpenMontageNotificationOutboxSync({ status: "pending" }).at(-1)?.eventSequence, 3);
});

test("event nonce cannot be replayed even for a different event", () => {
  createLink();
  const started = event(2, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  });
  ingestOpenMontageJobEventSync(started, { nonce: "nonce-once" });

  assert.throws(
    () => ingestOpenMontageJobEventSync(
      { ...started, eventId: "om_evt_3", sequence: 3 },
      { nonce: "nonce-once" },
    ),
    /nonce/,
  );
});
