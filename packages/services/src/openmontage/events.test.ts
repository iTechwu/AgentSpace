import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  callOpenMontageJobActionAsync,
  OpenMontageEventAuthenticationError,
  reconcileOpenMontageJobAsync,
  reconcileSyncingOpenMontageJobsAsync,
  verifyOpenMontageEventRequest,
} from "./events.ts";

const SECRET = "event-secret";
const NOW = new Date("2026-08-05T10:00:00Z");

function event() {
  return {
    schemaVersion: 1,
    eventId: "om_evt_1",
    eventType: "openmontage.job.failed",
    occurredAt: "2026-08-05T10:00:00Z",
    jobId: "om_job_1",
    sequence: 2,
    workspaceId: "default",
    employeeId: "employee-1",
    runtimeId: "runtime-1",
    rootTaskId: "task-1",
    conversationId: "conversation-1",
    sourceInvocationId: "invocation-1",
    traceId: "trace-1",
    payload: {
      stage: "research",
      status: "FAILED",
      error: {
        code: "OPENMONTAGE_MODEL_UPSTREAM_FAILED",
        message: "Provider failed at /data/projects/private/token.txt with Bearer top-secret",
        retryable: true,
      },
    },
  };
}

function signedRequest(overrides: { timestamp?: string; nonce?: string; body?: Uint8Array } = {}) {
  const body = overrides.body ?? new TextEncoder().encode(JSON.stringify(event()));
  const timestamp = overrides.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const nonce = overrides.nonce ?? "nonce-1";
  const message = Buffer.concat([
    Buffer.from(timestamp),
    Buffer.from("."),
    Buffer.from(nonce),
    Buffer.from("."),
    Buffer.from(body),
  ]);
  const signature = createHmac("sha256", SECRET).update(message).digest("hex");
  return {
    body,
    headers: new Headers({
      "X-OpenMontage-Event-Id": event().eventId,
      "X-OpenMontage-Timestamp": timestamp,
      "X-OpenMontage-Nonce": nonce,
      "X-OpenMontage-Signature": signature,
    }),
  };
}

test("verifies the exact signed bytes and redacts unsafe payload strings", () => {
  const request = signedRequest();

  const result = verifyOpenMontageEventRequest({
    ...request,
    secret: SECRET,
    now: NOW,
  });

  assert.equal(result.nonce, "nonce-1");
  assert.equal(result.event.eventId, "om_evt_1");
  assert.doesNotMatch(JSON.stringify(result.event), /top-secret|\/data\/projects/);
  assert.match(JSON.stringify(result.event), /\[redacted\]/);
});

test("rejects tampered bodies, stale timestamps, and mismatched event ids", () => {
  const valid = signedRequest();
  const tampered = new Uint8Array([...valid.body, 32]);
  assert.throws(
    () => verifyOpenMontageEventRequest({ ...valid, body: tampered, secret: SECRET, now: NOW }),
    OpenMontageEventAuthenticationError,
  );

  const stale = signedRequest({ timestamp: String(Math.floor(NOW.getTime() / 1000) - 301) });
  assert.throws(
    () => verifyOpenMontageEventRequest({ ...stale, secret: SECRET, now: NOW }),
    /expired/,
  );

  const wrongId = signedRequest();
  wrongId.headers.set("X-OpenMontage-Event-Id", "om_evt_other");
  assert.throws(
    () => verifyOpenMontageEventRequest({ ...wrongId, secret: SECRET, now: NOW }),
    /event id/i,
  );
});

test("rejects oversized bodies before JSON parsing", () => {
  const request = signedRequest({ body: new Uint8Array(256 * 1024 + 1) });

  assert.throws(
    () => verifyOpenMontageEventRequest({ ...request, secret: SECRET, now: NOW }),
    /too large/,
  );
});

test("reconciles missing events with trusted Job attribution and dispatches the durable notification", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const ingested: string[] = [];
  const dispatched: string[] = [];
  let lastAppliedSequence = 1;
  const missingEvent = {
    ...event(),
    eventId: "om_evt_2",
    eventType: "openmontage.stage.started",
    payload: {
      stage: "research",
      stageAttempt: 1,
      status: "RUNNING",
      approvalStatus: "NOT_REQUIRED",
    },
  };

  const result = await reconcileOpenMontageJobAsync("om_job_1", {
    environment: {
      OPENMONTAGE_BASE_URL: "http://openmontage.internal:8765/",
      OPENMONTAGE_SERVICE_TOKEN: "service-token",
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ events: [missingEvent], lastSequence: 2 });
    },
    readLink: () => ({
      jobId: "om_job_1",
      workspaceId: "default",
      employeeId: "employee-1",
      runtimeId: "runtime-1",
      rootTaskId: "task-1",
      conversationId: "conversation-1",
      sourceInvocationId: "invocation-1",
      traceId: "trace-1",
      workflowName: "animated-explainer",
      workflowVersion: "2.0",
      createdAt: "2026-08-05T10:00:00Z",
    }),
    readProjection: () => ({
      jobId: "om_job_1",
      lastAppliedSequence,
    } as never),
    ingest: (nextEvent) => {
      ingested.push(nextEvent.eventId);
      lastAppliedSequence = nextEvent.sequence;
      return {
        outcome: "applied" as const,
        projection: { lastAppliedSequence } as never,
        notification: { id: `notify-${nextEvent.sequence}` } as never,
      };
    },
    dispatch: (notification) => dispatched.push(notification.id),
  });

  assert.deepEqual(result, { received: 1, lastAppliedSequence: 2, remoteLastSequence: 2 });
  assert.equal(calls[0]?.url, "http://openmontage.internal:8765/api/v1/jobs/om_job_1/events?afterSequence=1");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer service-token");
  const attribution = JSON.parse(Buffer.from(
    calls[0]?.headers.get("x-dofe-job-attribution") ?? "",
    "base64url",
  ).toString("utf8"));
  assert.equal(attribution.employeeId, "employee-1");
  assert.deepEqual(ingested, ["om_evt_2"]);
  assert.deepEqual(dispatched, ["notify-2"]);
});

test("scheduled reconciliation isolates one Job failure from the remaining batch", async () => {
  const attempted: string[] = [];
  const result = await reconcileSyncingOpenMontageJobsAsync({
    limit: 10,
    listJobIds: () => ["om_job_1", "om_job_2"],
    reconcile: async (jobId) => {
      attempted.push(jobId);
      if (jobId === "om_job_1") {
        throw new Error("temporarily unavailable");
      }
      return { received: 1, lastAppliedSequence: 3, remoteLastSequence: 3 };
    },
  });

  assert.deepEqual(attempted, ["om_job_1", "om_job_2"]);
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 1 });
});

test("submits Job actions with trusted attribution, sequence fencing, and immediate reconciliation", async () => {
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: string }> = [];
  const reconciled: string[] = [];
  const link = {
    jobId: "om_job_1",
    workspaceId: "default",
    employeeId: "employee-1",
    runtimeId: "runtime-1",
    rootTaskId: "task-1",
    conversationId: "conversation-1",
    sourceInvocationId: "invocation-1",
    traceId: "trace-1",
    workflowName: "animated-explainer",
    workflowVersion: "2.0",
    createdAt: "2026-08-05T10:00:00Z",
  };

  await callOpenMontageJobActionAsync({
    workspaceId: "default",
    jobId: "om_job_1",
    action: "approve",
    stage: "proposal",
    expectedSequence: 4,
  }, {
    environment: {
      OPENMONTAGE_BASE_URL: "http://openmontage.internal:8765/",
      OPENMONTAGE_SERVICE_TOKEN: "service-token",
    },
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({ jobId: "om_job_1", lastSequence: 5 });
    },
    readLink: () => link,
    readProjection: () => ({
      lastAppliedSequence: 4,
      status: "WAITING_APPROVAL",
      currentStage: "proposal",
    } as never),
    reconcile: async (jobId) => {
      reconciled.push(jobId);
      return { received: 1, lastAppliedSequence: 5, remoteLastSequence: 5 };
    },
  });

  assert.equal(calls[0]?.url, "http://openmontage.internal:8765/api/v1/jobs/om_job_1/approve");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer service-token");
  assert.equal(calls[0]?.headers.get("idempotency-key"), "openmontage:om_job_1:4:approve:proposal");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { stage: "proposal", approved: true });
  assert.deepEqual(reconciled, ["om_job_1"]);

  await assert.rejects(
    () => callOpenMontageJobActionAsync({
      workspaceId: "default",
      jobId: "om_job_1",
      action: "cancel",
      expectedSequence: 3,
    }, {
      environment: {
        OPENMONTAGE_BASE_URL: "http://openmontage.internal:8765/",
        OPENMONTAGE_SERVICE_TOKEN: "service-token",
      },
      readLink: () => link,
      readProjection: () => ({ lastAppliedSequence: 4 } as never),
    }),
    /changed since the action was requested/,
  );
});
