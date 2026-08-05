import { createHmac, timingSafeEqual } from "node:crypto";
import { parseOpenMontageJobEvent, type OpenMontageJobEvent } from "@dofe-agent/domain";
import {
  ingestOpenMontageJobEventSync,
  markOpenMontageNotificationDeliveredSync,
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
