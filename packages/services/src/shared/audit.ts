import type { LedgerItem } from "@dofe-agent/domain/workspace";
import { isPlatformAdminUserSync, recordAuditLogSync, type AuditLogSource } from "@dofe-agent/db";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "./state-io.ts";

const MAX_AUDIT_LEDGER_ENTRIES = 200;
const PLATFORM_ADMIN_DISPLAY_NAME = "平台运维";

type AuditValue = string | number | boolean | null | undefined;

export function recordWorkspaceAuditEventSync(input: {
  workspaceId: string;
  title: string;
  note: string;
  code?: string;
  data?: Record<string, AuditValue>;
}): void {
  const state = readWorkspaceStateSync(input.workspaceId);
  const entry: LedgerItem = {
    title: input.title,
    note: input.note,
    code: input.code,
    data: normalizeAuditData(input.data),
  };

  state.ledger = [entry, ...state.ledger].slice(0, MAX_AUDIT_LEDGER_ENTRIES);
  writeWorkspaceStateSync(state, input.workspaceId);
}

export function tryRecordWorkspaceAuditEventSync(input: {
  workspaceId: string;
  title: string;
  note: string;
  code?: string;
  data?: Record<string, AuditValue>;
}): boolean {
  try {
    recordWorkspaceAuditEventSync(anonymizePlatformAdminActor(input));
    return true;
  } catch {
    return false;
  }
}

export function recordPlatformAuditEventSync(input: {
  title: string;
  note: string;
  code?: string;
  data?: Record<string, AuditValue>;
}): ReturnType<typeof recordAuditLogSync> {
  return recordAuditLogSync({
    title: input.title,
    note: input.note,
    code: input.code,
    source: "platform_admin" as AuditLogSource,
    data: input.data,
  });
}

export function tryRecordPlatformAuditEventSync(input: {
  title: string;
  note: string;
  code?: string;
  data?: Record<string, AuditValue>;
}): boolean {
  try {
    recordPlatformAuditEventSync(input);
    return true;
  } catch {
    return false;
  }
}

function normalizeAuditData(data: Record<string, AuditValue> | undefined): Record<string, string> | undefined {
  if (!data) {
    return undefined;
  }

  const entries = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value === null ? "null" : String(value)] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function anonymizePlatformAdminActor(
  input: {
    workspaceId: string;
    title: string;
    note: string;
    code?: string;
    data?: Record<string, AuditValue>;
  },
): typeof input {
  const actorUserId = typeof input.data?.userId === "string" ? input.data.userId : undefined;
  if (!actorUserId || !isPlatformAdminUserSync(actorUserId)) {
    return input;
  }

  const sanitizedData = { ...input.data };
  delete sanitizedData.userId;
  delete sanitizedData.email;
  delete sanitizedData.displayName;
  sanitizedData.actorType = "platform_admin";
  sanitizedData.displayName = PLATFORM_ADMIN_DISPLAY_NAME;

  return {
    ...input,
    title: `${input.title} (${PLATFORM_ADMIN_DISPLAY_NAME})`,
    note: input.note,
    data: sanitizedData,
  };
}
