import { createHash } from "node:crypto";
import type { AuditLogRecord, AuditLogSource } from "./types.ts";

export interface ResolvedAuditLogWrite {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code: string | null;
  source: AuditLogSource;
  dataJson: string;
  idempotent: boolean;
}

export function resolveAuditLogWrite(input: {
  workspaceId: string;
  idempotencyKey?: string;
  title: string;
  note: string;
  code?: string;
  source?: AuditLogSource;
  data?: Record<string, unknown>;
  createRandomId: () => string;
}): ResolvedAuditLogWrite {
  const rawKey = input.idempotencyKey;
  const normalizedKey = rawKey?.trim();
  if (rawKey !== undefined && !normalizedKey) {
    throw new Error("audit_log.idempotency_key_required");
  }
  if (normalizedKey && normalizedKey.length > 512) {
    throw new Error("audit_log.idempotency_key_too_long");
  }
  return {
    id: normalizedKey
      ? `audit-idem-${createHash("sha256").update(input.workspaceId).update("\0").update(normalizedKey).digest("hex")}`
      : input.createRandomId(),
    workspaceId: input.workspaceId,
    title: input.title,
    note: input.note,
    code: input.code ?? null,
    source: input.source ?? "runtime_lifecycle",
    dataJson: canonicalizeAuditLogDataJson(input.data ?? {}),
    idempotent: Boolean(normalizedKey),
  };
}

export function assertAuditLogIdempotencyMatch(
  persisted: AuditLogRecord,
  expected: ResolvedAuditLogWrite,
): void {
  if (!expected.idempotent) {
    return;
  }
  if (
    persisted.id !== expected.id
    || persisted.workspaceId !== expected.workspaceId
    || persisted.title !== expected.title
    || persisted.note !== expected.note
    || (persisted.code ?? null) !== expected.code
    || persisted.source !== expected.source
    || canonicalizeAuditLogDataJson(persisted.dataJson) !== expected.dataJson
  ) {
    throw new Error("audit_log.idempotency_conflict");
  }
}

export function canonicalizeAuditLogDataJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return canonicalJsonValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return canonicalJsonValue(value);
}

function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
