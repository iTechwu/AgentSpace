import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import {
  createOpenMontageJobLinkSync,
  ingestOpenMontageJobEventSync,
  listOpenMontageChannelProjectionsSync,
  listOpenMontageChannelProjectionVersionsSync,
  listOpenMontageNotificationOutboxSync,
  listOpenMontageSyncingJobIdsSync,
  readOpenMontageChatBindingSync,
  readOpenMontageJobProjectionSync,
} from "./openmontage-jobs.ts";
import {
  consumeOpenMontageArtifactReadGrantSync,
  consumeOpenMontageArtifactWriteGrantSync,
  issueOpenMontageArtifactReadGrantSync,
  issueOpenMontageArtifactWriteGrantSync,
} from "./openmontage-artifacts.ts";
import { getDatabase } from "./database.ts";
import { parseOpenMontageJobEvent, type OpenMontageJobEvent } from "@dofe-agent/domain";

before(() => {
  process.env.NODE_ENV = "test";
});

function clearOpenMontageTables(): void {
  getDatabase().exec(`
    DELETE FROM openmontage_artifact_grant;
    DELETE FROM openmontage_notification_outbox;
    DELETE FROM openmontage_event_nonce;
    DELETE FROM openmontage_chat_binding;
    DELETE FROM openmontage_job_event;
    DELETE FROM openmontage_job_projection;
    DELETE FROM openmontage_job_link;
  `);
}

function insertAttachment(input: {
  id?: string;
  channelName?: string;
  sha256?: string;
} = {}): void {
  const now = "2026-08-05T10:00:00Z";
  getDatabase().prepare(
    `INSERT INTO attachment (
      workspace_id, id, message_id, channel_name, speaker, role,
      file_name, media_type, kind, size_bytes, stored_path,
      storage_provider, storage_key, sha256, source_message_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      channel_name = EXCLUDED.channel_name,
      storage_key = EXCLUDED.storage_key,
      sha256 = EXCLUDED.sha256`,
  ).run(
    "default",
    input.id ?? "att-video-1",
    "message-input",
    input.channelName ?? "direct:employee-1",
    "User",
    "human",
    "reference.mp4",
    "video/mp4",
    "file",
    128,
    "tos://test/attachments/reference.mp4",
    "tos",
    "workspaces/default/attachments/reference.mp4",
    input.sha256 ?? "a".repeat(64),
    0,
    now,
  );
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
  assert.deepEqual(
    listOpenMontageChannelProjectionVersionsSync("default", "direct:employee-1"),
    [{ jobId: "om_job_1", lastAppliedSequence: 1, changedAt: "2026-08-05T10:00:01.000Z" }],
  );
  assert.deepEqual(
    listOpenMontageChannelProjectionsSync("default", "direct:employee-1").map((item) => item.jobId),
    ["om_job_1"],
  );
  assert.deepEqual(
    listOpenMontageChannelProjectionsSync("default", "another-channel"),
    [],
  );

  assert.throws(
    () => createLink({ employeeId: "employee-2" }),
    /immutable attribution/,
  );
  assert.throws(
    () => createLink({ channelName: "direct:employee-2" }),
    /chat binding/,
  );
});

test("artifact read grant stores only a token hash and can be consumed once", () => {
  createLink();
  insertAttachment();

  const issued = issueOpenMontageArtifactReadGrantSync({
    workspaceId: "default",
    jobId: "om_job_1",
    attachmentId: "att-video-1",
    now: "2026-08-05T10:00:00Z",
    ttlSeconds: 300,
  });
  const persisted = getDatabase().prepare(
    `SELECT token_hash AS "tokenHash" FROM openmontage_artifact_grant WHERE id = ?`,
  ).get(issued.grant.id) as { tokenHash?: string } | undefined;

  assert.ok(issued.token.length >= 32);
  assert.notEqual(persisted?.tokenHash, issued.token);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const consumed = consumeOpenMontageArtifactReadGrantSync({
    grantId: issued.grant.id,
    token: issued.token,
    now: "2026-08-05T10:00:01Z",
  });
  assert.equal(consumed.attachment.id, "att-video-1");
  assert.equal(consumed.attachment.sha256, "a".repeat(64));

  assert.throws(
    () => consumeOpenMontageArtifactReadGrantSync({
      grantId: issued.grant.id,
      token: issued.token,
      now: "2026-08-05T10:00:02Z",
    }),
    /already consumed/,
  );
});

test("artifact read grant rejects wrong tokens, expiry, and cross-channel attachments", () => {
  createLink();
  insertAttachment();
  insertAttachment({ id: "att-other-channel", channelName: "team:private" });
  const issued = issueOpenMontageArtifactReadGrantSync({
    workspaceId: "default",
    jobId: "om_job_1",
    attachmentId: "att-video-1",
    now: "2026-08-05T10:00:00Z",
    ttlSeconds: 1,
  });

  assert.throws(
    () => consumeOpenMontageArtifactReadGrantSync({
      grantId: issued.grant.id,
      token: "wrong-token-with-sufficient-length-1234567890",
      now: "2026-08-05T10:00:00Z",
    }),
    /invalid/,
  );
  assert.throws(
    () => consumeOpenMontageArtifactReadGrantSync({
      grantId: issued.grant.id,
      token: issued.token,
      now: "2026-08-05T10:00:02Z",
    }),
    /expired/,
  );
  assert.throws(
    () => issueOpenMontageArtifactReadGrantSync({
      workspaceId: "default",
      jobId: "om_job_1",
      attachmentId: "att-other-channel",
      now: "2026-08-05T10:00:00Z",
    }),
    /same channel/,
  );
});

test("artifact write grant binds immutable output metadata and can be consumed once", () => {
  createLink();

  const issued = issueOpenMontageArtifactWriteGrantSync({
    workspaceId: "default",
    jobId: "om_job_1",
    role: "final_video",
    fileName: "final.mp4",
    mediaType: "video/mp4",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
    now: "2026-08-05T10:00:00Z",
    ttlSeconds: 300,
  });
  const consumed = consumeOpenMontageArtifactWriteGrantSync({
    grantId: issued.grant.id,
    token: issued.token,
    now: "2026-08-05T10:00:01Z",
  });

  assert.deepEqual(consumed, {
    ...issued.grant,
    consumedAt: "2026-08-05T10:00:01.000Z",
  });
  assert.equal(consumed.operation, "WRITE");
  assert.equal(consumed.role, "final_video");
  assert.equal(consumed.sha256, "b".repeat(64));
  assert.throws(
    () => consumeOpenMontageArtifactWriteGrantSync({
      grantId: issued.grant.id,
      token: issued.token,
      now: "2026-08-05T10:00:02Z",
    }),
    /already consumed/,
  );
});

test("artifact write grant rejects unsafe output metadata before persistence", () => {
  createLink();
  const baseline = {
    workspaceId: "default",
    jobId: "om_job_1",
    role: "final_video",
    fileName: "final.mp4",
    mediaType: "video/mp4",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
  };

  assert.throws(
    () => issueOpenMontageArtifactWriteGrantSync({ ...baseline, fileName: "../final.mp4" }),
    /fileName/,
  );
  assert.throws(
    () => issueOpenMontageArtifactWriteGrantSync({ ...baseline, mediaType: "text/html" }),
    /mediaType/,
  );
  assert.throws(
    () => issueOpenMontageArtifactWriteGrantSync({ ...baseline, sha256: "invalid" }),
    /sha256/,
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
  assert.deepEqual(listOpenMontageSyncingJobIdsSync({ limit: 10 }), ["om_job_1"]);

  const reconciled = ingestOpenMontageJobEventSync(started, { nonce: "nonce-start" });
  assert.equal(reconciled.outcome, "applied");
  assert.equal(reconciled.projection.syncStatus, "CURRENT");
  assert.equal(reconciled.projection.lastAppliedSequence, 3);
  assert.equal(reconciled.projection.stages[0]?.status, "SUCCEEDED");
  assert.deepEqual(listOpenMontageSyncingJobIdsSync({ limit: 10 }), []);
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
