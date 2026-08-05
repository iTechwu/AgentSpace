import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { parseOpenMontageJobEvent, type OpenMontageJobEvent } from "@dofe-agent/domain";
import {
  ingestOpenMontageJobEventSync,
  listOpenMontageSyncingJobIdsSync,
  markOpenMontageNotificationDeliveredSync,
  readOpenMontageJobLinkSync,
  readOpenMontageJobProjectionSync,
  type OpenMontageJobLinkRecord,
  type OpenMontageNotificationOutboxRecord,
} from "@dofe-agent/db";
import { publishOpenMontageJobChangedEvent } from "../realtime/events.ts";

const MAX_EVENT_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 300;

export class OpenMontageEventAuthenticationError extends Error {}
export class OpenMontageEventValidationError extends Error {}

export interface VerifiedOpenMontageEventRequest {
  event: OpenMontageJobEvent;
  nonce: string;
  timestamp: number;
}

export interface OpenMontageJobActionInput {
  workspaceId: string;
  jobId: string;
  action: "approve" | "reject" | "cancel";
  stage?: string;
  expectedSequence: number;
}

export function verifyOpenMontageEventRequest(input: {
  body: Uint8Array;
  headers: Headers | Record<string, string | undefined>;
  secret: string;
  now?: Date;
  maxAgeSeconds?: number;
}): VerifiedOpenMontageEventRequest {
  if (!input.secret) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event signing secret is not configured.");
  }
  if (input.body.byteLength > MAX_EVENT_BODY_BYTES) {
    throw new OpenMontageEventValidationError("OpenMontage event body is too large.");
  }

  const timestampValue = requireHeader(input.headers, "X-OpenMontage-Timestamp");
  const nonce = requireHeader(input.headers, "X-OpenMontage-Nonce");
  const suppliedSignature = requireHeader(input.headers, "X-OpenMontage-Signature");
  const suppliedEventId = requireHeader(input.headers, "X-OpenMontage-Event-Id");
  if (!/^\d+$/.test(timestampValue)) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event timestamp is invalid.");
  }
  if (!nonce || nonce.length > 256) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event nonce is invalid.");
  }
  if (!/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event signature is invalid.");
  }

  const timestamp = Number(timestampValue);
  const now = input.now ?? new Date();
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > maxAgeSeconds) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event signature has expired.");
  }

  const signedBytes = Buffer.concat([
    Buffer.from(timestampValue, "ascii"),
    Buffer.from("."),
    Buffer.from(nonce, "utf8"),
    Buffer.from("."),
    Buffer.from(input.body),
  ]);
  const expected = createHmac("sha256", input.secret).update(signedBytes).digest();
  const supplied = Buffer.from(suppliedSignature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event signature is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)) as unknown;
  } catch (error) {
    throw new OpenMontageEventValidationError("OpenMontage event body is not valid UTF-8 JSON.", {
      cause: error,
    });
  }
  let event: OpenMontageJobEvent;
  try {
    event = parseOpenMontageJobEvent(decoded);
  } catch (error) {
    throw new OpenMontageEventValidationError("OpenMontage event does not match schema v1.", {
      cause: error,
    });
  }
  if (event.eventId !== suppliedEventId) {
    throw new OpenMontageEventAuthenticationError("OpenMontage event id header does not match the signed body.");
  }

  return {
    event: {
      ...event,
      payload: sanitizePayload(event.payload),
    },
    nonce,
    timestamp,
  };
}

export function ingestSignedOpenMontageEventSync(input: {
  body: Uint8Array;
  headers: Headers | Record<string, string | undefined>;
  secret: string;
  now?: Date;
}) {
  const verified = verifyOpenMontageEventRequest(input);
  const receivedAt = (input.now ?? new Date()).toISOString();
  return ingestOpenMontageJobEventSync(verified.event, {
    nonce: verified.nonce,
    receivedAt,
    nonceExpiresAt: new Date((verified.timestamp + DEFAULT_MAX_AGE_SECONDS * 2) * 1000).toISOString(),
  });
}

export function dispatchOpenMontageProjectionNotificationSync(
  notification: OpenMontageNotificationOutboxRecord,
): void {
  publishOpenMontageJobChangedEvent({
    workspaceId: notification.workspaceId,
    channelName: notification.channelName,
    jobId: notification.jobId,
    lastAppliedSequence: readRequiredNumber(notification.payload.lastAppliedSequence),
    changedAt: readRequiredString(notification.payload.changedAt),
  });
  markOpenMontageNotificationDeliveredSync(notification.id);
}

export async function reconcileOpenMontageJobAsync(
  jobId: string,
  options: {
    environment?: Record<string, string | undefined>;
    fetch?: typeof globalThis.fetch;
    readLink?: typeof readOpenMontageJobLinkSync;
    readProjection?: typeof readOpenMontageJobProjectionSync;
    ingest?: typeof ingestOpenMontageJobEventSync;
    dispatch?: typeof dispatchOpenMontageProjectionNotificationSync;
  } = {},
): Promise<{ received: number; lastAppliedSequence: number; remoteLastSequence: number }> {
  const environment = options.environment ?? process.env;
  const baseUrl = resolveOpenMontageBaseUrl(environment.OPENMONTAGE_BASE_URL);
  const serviceToken = environment.OPENMONTAGE_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    throw new Error("OPENMONTAGE_SERVICE_TOKEN is required for reconciliation.");
  }
  const readLink = options.readLink ?? readOpenMontageJobLinkSync;
  const readProjection = options.readProjection ?? readOpenMontageJobProjectionSync;
  const ingest = options.ingest ?? ingestOpenMontageJobEventSync;
  const dispatch = options.dispatch ?? dispatchOpenMontageProjectionNotificationSync;
  const link = readLink(jobId);
  if (!link) {
    throw new Error("OpenMontage Job has no trusted AgentSpace binding.");
  }
  const projection = readProjection(link.workspaceId, jobId);
  if (!projection) {
    throw new Error("OpenMontage Job projection is missing.");
  }
  const attribution = encodeTrustedAttribution(link);
  const endpoint = new URL(
    `/api/v1/jobs/${encodeURIComponent(jobId)}/events`,
    baseUrl,
  );
  endpoint.searchParams.set("afterSequence", String(projection.lastAppliedSequence));
  const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "X-Dofe-Job-Attribution": attribution,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenMontage reconciliation returned HTTP ${response.status}.`);
  }
  const body = await response.json() as unknown;
  const replay = parseReplayResponse(body);
  let lastAppliedSequence = projection.lastAppliedSequence;
  for (const candidate of replay.events) {
    const event = sanitizeOpenMontageEventForStorage(parseOpenMontageJobEvent(candidate));
    const result = ingest(event, {
      nonce: `reconcile-${event.eventId}-${randomUUID()}`,
    });
    lastAppliedSequence = result.projection.lastAppliedSequence;
    if (result.notification) {
      try {
        dispatch(result.notification);
      } catch {
        // Persisted polling and the notification outbox remain recovery paths.
      }
    }
  }
  if (lastAppliedSequence < replay.lastSequence) {
    throw new Error(
      `OpenMontage reconciliation remained incomplete at sequence ${lastAppliedSequence} of ${replay.lastSequence}.`,
    );
  }
  return {
    received: replay.events.length,
    lastAppliedSequence,
    remoteLastSequence: replay.lastSequence,
  };
}

export async function reconcileSyncingOpenMontageJobsAsync(options: {
  limit?: number;
  listJobIds?: typeof listOpenMontageSyncingJobIdsSync;
  reconcile?: typeof reconcileOpenMontageJobAsync;
} = {}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const jobIds = (options.listJobIds ?? listOpenMontageSyncingJobIdsSync)({
    limit: options.limit ?? 50,
  });
  let succeeded = 0;
  let failed = 0;
  for (const jobId of jobIds) {
    try {
      await (options.reconcile ?? reconcileOpenMontageJobAsync)(jobId);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: jobIds.length, succeeded, failed };
}

export async function callOpenMontageJobActionAsync(
  input: OpenMontageJobActionInput,
  options: {
    environment?: Record<string, string | undefined>;
    fetch?: typeof globalThis.fetch;
    readLink?: typeof readOpenMontageJobLinkSync;
    readProjection?: typeof readOpenMontageJobProjectionSync;
    reconcile?: typeof reconcileOpenMontageJobAsync;
  } = {},
): Promise<{ accepted: true }> {
  const environment = options.environment ?? process.env;
  const baseUrl = resolveOpenMontageBaseUrl(environment.OPENMONTAGE_BASE_URL);
  const serviceToken = environment.OPENMONTAGE_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    throw new Error("OPENMONTAGE_SERVICE_TOKEN is required for Job actions.");
  }
  const link = (options.readLink ?? readOpenMontageJobLinkSync)(input.jobId);
  if (!link || link.workspaceId !== input.workspaceId) {
    throw new Error("OpenMontage Job has no trusted AgentSpace binding.");
  }
  const projection = (options.readProjection ?? readOpenMontageJobProjectionSync)(input.workspaceId, input.jobId);
  if (!projection) {
    throw new Error("OpenMontage Job projection is missing.");
  }
  if (projection.lastAppliedSequence !== input.expectedSequence) {
    throw new Error("OpenMontage Job changed since the action was requested. Refresh and try again.");
  }

  const isApprovalAction = input.action === "approve" || input.action === "reject";
  const stage = input.stage?.trim();
  if (isApprovalAction) {
    if (!stage || projection.status !== "WAITING_APPROVAL" || projection.currentStage !== stage) {
      throw new Error("OpenMontage approval is no longer actionable.");
    }
  } else if (!(["QUEUED", "RUNNING"] as const).includes(projection.status as "QUEUED" | "RUNNING")) {
    throw new Error("OpenMontage Job can no longer be cancelled.");
  }

  const actionPath = isApprovalAction ? "approve" : "cancel";
  const endpoint = new URL(
    `/api/v1/jobs/${encodeURIComponent(input.jobId)}/${actionPath}`,
    baseUrl,
  );
  const idempotencyKey = [
    "openmontage",
    input.jobId,
    input.expectedSequence,
    input.action,
    stage,
  ].filter(Boolean).join(":");
  const body = isApprovalAction
    ? JSON.stringify({ stage, approved: input.action === "approve", expectedSequence: input.expectedSequence })
    : JSON.stringify({ expectedSequence: input.expectedSequence });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
    "Idempotency-Key": idempotencyKey,
    "X-Dofe-Job-Attribution": encodeTrustedAttribution(link),
  };
  headers["Content-Type"] = "application/json";
  const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenMontage Job action returned HTTP ${response.status}.`);
  }

  try {
    await (options.reconcile ?? reconcileOpenMontageJobAsync)(input.jobId, { environment });
  } catch {
    // Signed callbacks and scheduled reconciliation remain recovery paths.
  }
  return { accepted: true };
}

export function sanitizeOpenMontageEventForStorage(
  event: OpenMontageJobEvent,
): OpenMontageJobEvent {
  return {
    ...event,
    payload: sanitizePayload(event.payload),
  };
}

function requireHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string {
  const value = headers instanceof Headers
    ? headers.get(name)
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (!value) {
    throw new OpenMontageEventAuthenticationError(`Missing OpenMontage event header ${name}.`);
  }
  return value;
}

function resolveOpenMontageBaseUrl(value: string | undefined): URL {
  if (!value?.trim()) {
    throw new Error("OPENMONTAGE_BASE_URL is required.");
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("OPENMONTAGE_BASE_URL must be an HTTP(S) service URL without credentials.");
  }
  return url;
}

function encodeTrustedAttribution(link: OpenMontageJobLinkRecord): string {
  return Buffer.from(JSON.stringify({
    workspaceId: link.workspaceId,
    employeeId: link.employeeId,
    runtimeId: link.runtimeId,
    rootTaskId: link.rootTaskId,
    conversationId: link.conversationId,
    sourceInvocationId: link.sourceInvocationId,
    traceId: link.traceId,
  }), "utf8").toString("base64url");
}

function parseReplayResponse(value: unknown): { events: unknown[]; lastSequence: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenMontage reconciliation response is invalid.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.events)) {
    throw new Error("OpenMontage reconciliation response events are invalid.");
  }
  if (
    typeof source.lastSequence !== "number"
    || !Number.isInteger(source.lastSequence)
    || source.lastSequence < 0
  ) {
    throw new Error("OpenMontage reconciliation response sequence is invalid.");
  }
  return { events: source.events, lastSequence: source.lastSequence };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(payload, "payload") as Record<string, unknown>;
}

function sanitizeValue(value: unknown, key: string): unknown {
  if (/authorization|password|cookie|(?:^|[_-])(?:api[_-]?key|secret|token)(?:$|[_-])/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\/(?:Users|home|data|srv|app|tmp)\/[^\s"']+/g, "[redacted]")
      .replace(/https?:\/\/[^\s"']+/gi, "[redacted]")
      .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([nestedKey, nestedValue]) => [nestedKey, sanitizeValue(nestedValue, nestedKey)]),
    );
  }
  return value;
}

function readRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("OpenMontage notification payload is invalid.");
  }
  return value;
}

function readRequiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("OpenMontage notification payload is invalid.");
  }
  return value;
}
