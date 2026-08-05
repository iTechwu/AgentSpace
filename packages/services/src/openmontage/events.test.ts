import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  OpenMontageEventAuthenticationError,
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
