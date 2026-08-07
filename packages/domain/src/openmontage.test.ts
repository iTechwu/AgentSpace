import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOpenMontageJobEvent,
  createOpenMontageJobProjection,
  parseOpenMontageJobEvent,
  parseOpenMontageSubmittedJob,
  type OpenMontageJobEvent,
} from "./openmontage.ts";

function submittedJob() {
  return {
    schemaVersion: 1,
    jobId: "om_job_1",
    status: "QUEUED",
    workflow: {
      name: "animated-explainer",
      version: "2.0",
      stages: [
        { code: "research", labelCode: "openmontage.stage.research", approvalRequired: false },
        { code: "proposal", labelCode: "openmontage.stage.proposal", approvalRequired: true },
      ],
    },
    attribution: {
      workspaceId: "ws-1",
      employeeId: "employee-1",
      runtimeId: "runtime-1",
      rootTaskId: "task-1",
      conversationId: "conversation-1",
      sourceInvocationId: "invocation-1",
      traceId: "trace-1",
    },
    request: {
      schemaVersion: 1,
      clientRequestId: "client-request-1",
      workflow: "animated-explainer",
      input: {},
      brief: {},
      output: {},
      budget: { maxAmount: "20.00", currency: "CNY" },
    },
    stages: [
      {
        code: "research",
        labelCode: "openmontage.stage.research",
        approvalRequired: false,
        approvalStatus: "NOT_REQUIRED",
        status: "PENDING",
        attempt: 0,
      },
      {
        code: "proposal",
        labelCode: "openmontage.stage.proposal",
        approvalRequired: true,
        approvalStatus: "REQUIRED",
        status: "PENDING",
        attempt: 0,
      },
    ],
    lastSequence: 1,
    createdAt: "2026-08-05T10:00:01Z",
    updatedAt: "2026-08-05T10:00:01Z",
  };
}

test("submitted Job parsing validates the full OpenMontage response and produces a projection seed", () => {
  const parsed = parseOpenMontageSubmittedJob(submittedJob());

  assert.equal(parsed.attribution.employeeId, "employee-1");
  assert.equal(parsed.clientRequestId, "client-request-1");
  assert.deepEqual(parsed.budget, { maxAmount: "20.00", currency: "CNY" });
  assert.equal(parsed.snapshot.currentStage, null);
  assert.equal(parsed.snapshot.stages[1]?.approvalStatus, "REQUIRED");
});

test("submitted Job parsing accepts read-only fields returned by the Job snapshot API", () => {
  const snapshot = submittedJob();
  Object.assign(snapshot, {
    artifacts: [],
    usageSummary: { totalAmount: "0" },
    error: undefined,
  });
  const parsed = parseOpenMontageSubmittedJob(snapshot);
  assert.equal(parsed.snapshot.jobId, "om_job_1");
});

test("submitted Job parsing rejects forged attribution and inconsistent workflow stages", () => {
  const forged = submittedJob();
  forged.attribution = { ...forged.attribution, employeeId: "" };
  assert.throws(() => parseOpenMontageSubmittedJob(forged), /employeeId/);

  const inconsistent = submittedJob();
  inconsistent.stages = inconsistent.stages.slice(0, 1);
  assert.throws(() => parseOpenMontageSubmittedJob(inconsistent), /stages must match/);
});

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
    workspaceId: "ws-1",
    employeeId: "employee-1",
    runtimeId: "runtime-1",
    rootTaskId: "task-1",
    conversationId: "conversation-1",
    sourceInvocationId: "invocation-1",
    traceId: "trace-1",
    payload,
  });
}

function projection() {
  return createOpenMontageJobProjection({
    schemaVersion: 1,
    jobId: "om_job_1",
    status: "QUEUED",
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
        approvalStatus: "NOT_REQUIRED",
        status: "PENDING",
        attempt: 0,
      },
      {
        code: "proposal",
        labelCode: "openmontage.stage.proposal",
        approvalRequired: true,
        approvalStatus: "REQUIRED",
        status: "PENDING",
        attempt: 0,
      },
    ],
    currentStage: null,
    lastSequence: 1,
    createdAt: "2026-08-05T10:00:01Z",
    updatedAt: "2026-08-05T10:00:01Z",
  });
}

test("OpenMontage v1 event parsing rejects unknown versions and envelope fields", () => {
  const valid = event(2, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  });

  assert.throws(
    () => parseOpenMontageJobEvent({ ...valid, schemaVersion: 2 }),
    /schemaVersion/,
  );
  assert.throws(
    () => parseOpenMontageJobEvent({ ...valid, unexpected: true }),
    /unexpected/,
  );
});

test("artifact published events require a complete immutable manifest", () => {
  const payload = {
    artifactId: "eart-1",
    employeeId: "employee-1",
    role: "final_video",
    fileName: "final.mp4",
    mediaType: "video/mp4",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    publishedAt: "2026-08-05T10:00:02Z",
  };
  const published = event(2, "openmontage.artifact.published", payload);
  assert.deepEqual(
    applyOpenMontageJobEvent(projection(), published).projection.artifacts,
    [payload],
  );
  assert.throws(
    () => event(2, "openmontage.artifact.published", { ...payload, sha256: "invalid" }),
    /sha256/,
  );
  assert.throws(
    () => event(2, "openmontage.artifact.published", { ...payload, unexpected: true }),
    /unexpected/,
  );
});

test("projection applies factual stage progress in sequence", () => {
  const started = applyOpenMontageJobEvent(projection(), event(2, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  }));
  const progressed = applyOpenMontageJobEvent(started.projection, event(3, "openmontage.stage.progressed", {
    stage: "research",
    stageAttempt: 1,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
    progress: {
      completedUnits: 2,
      totalUnits: 5,
      labelCode: "openmontage.research.sources",
    },
  }));

  assert.equal(progressed.outcome, "applied");
  assert.equal(progressed.projection.status, "RUNNING");
  assert.equal(progressed.projection.currentStage, "research");
  assert.deepEqual(progressed.projection.stages[0]?.progress, {
    completedUnits: 2,
    totalUnits: 5,
    labelCode: "openmontage.research.sources",
  });
  assert.equal(progressed.projection.lastAppliedSequence, 3);
  assert.equal(progressed.projection.syncStatus, "CURRENT");
});

test("projection marks gaps as syncing without applying untrusted future state", () => {
  const result = applyOpenMontageJobEvent(projection(), event(3, "openmontage.stage.completed", {
    stage: "research",
    stageAttempt: 1,
    status: "SUCCEEDED",
    approvalStatus: "NOT_REQUIRED",
  }));

  assert.equal(result.outcome, "gap");
  assert.equal(result.projection.lastAppliedSequence, 1);
  assert.equal(result.projection.stages[0]?.status, "PENDING");
  assert.equal(result.projection.syncStatus, "SYNCING");
  assert.equal(result.projection.nextExpectedSequence, 2);
});

test("projection acknowledges duplicate events without replaying side effects", () => {
  const current = projection();
  const result = applyOpenMontageJobEvent(current, event(1, "openmontage.job.created", {
    workflow: { name: "animated-explainer", version: "2.0" },
  }));

  assert.equal(result.outcome, "duplicate");
  assert.deepEqual(result.projection, current);
});

test("terminal projection cannot regress when a later non-terminal event arrives", () => {
  const current = { ...projection(), status: "SUCCEEDED" as const, lastAppliedSequence: 8 };
  const result = applyOpenMontageJobEvent(current, event(9, "openmontage.stage.started", {
    stage: "research",
    stageAttempt: 2,
    status: "RUNNING",
    approvalStatus: "NOT_REQUIRED",
  }));

  assert.equal(result.outcome, "ignored_terminal");
  assert.equal(result.projection.status, "SUCCEEDED");
  assert.equal(result.projection.lastAppliedSequence, 9);
});

test("projection rejects stage events outside the manifest-derived stage list", () => {
  assert.throws(
    () => applyOpenMontageJobEvent(projection(), event(2, "openmontage.stage.started", {
      stage: "invented-stage",
      stageAttempt: 1,
      status: "RUNNING",
      approvalStatus: "NOT_REQUIRED",
    })),
    /Unknown OpenMontage stage/,
  );
});
