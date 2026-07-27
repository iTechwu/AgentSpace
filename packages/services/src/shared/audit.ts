import type { LedgerItem } from "@dofe-agent/domain/workspace";
import { createWorkspaceSync, isPlatformAdminUserSync, readUserSync, readWorkspaceSync, recordAuditLogSync, type AuditLogSource } from "@dofe-agent/db";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "./state-io.ts";

const MAX_AUDIT_LEDGER_ENTRIES = 200;
const PLATFORM_ADMIN_DISPLAY_NAME = "平台运维";
export const PLATFORM_AUDIT_WORKSPACE_ID = "platform-audit";

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
    const actorUserId = findPlatformAdminActorId(input.data);
    if (actorUserId) {
      recordPlatformAuditEventSync({
        title: input.title,
        note: input.note,
        code: input.code,
        data: {
          ...input.data,
          actorUserId,
          targetWorkspaceId: input.workspaceId,
        },
      });
    }
    recordWorkspaceAuditEventSync(anonymizePlatformAdminActor(input, actorUserId));
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
  ensurePlatformAuditWorkspace(input.data);
  return recordAuditLogSync({
    workspaceId: PLATFORM_AUDIT_WORKSPACE_ID,
    title: input.title,
    note: input.note,
    code: input.code,
    source: "platform_admin" as AuditLogSource,
    data: input.data,
  });
}

function ensurePlatformAuditWorkspace(data: Record<string, AuditValue> | undefined): void {
  if (readWorkspaceSync(PLATFORM_AUDIT_WORKSPACE_ID)) return;
  const actorUserId = typeof data?.actorUserId === "string" ? data.actorUserId : "";
  try {
    createWorkspaceSync({
      id: PLATFORM_AUDIT_WORKSPACE_ID,
      slug: PLATFORM_AUDIT_WORKSPACE_ID,
      name: "Platform audit",
      createdBy: actorUserId,
    });
  } catch (error) {
    if (!readWorkspaceSync(PLATFORM_AUDIT_WORKSPACE_ID)) throw error;
  }
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
  knownActorUserId?: string,
): typeof input {
  const actorUserId = knownActorUserId ?? findPlatformAdminActorId(input.data);
  if (!actorUserId) {
    return input;
  }

  const sanitizedData = { ...input.data };
  delete sanitizedData.userId;
  delete sanitizedData.actorId;
  delete sanitizedData.actorUserId;
  delete sanitizedData.requestedByUserId;
  delete sanitizedData.email;
  delete sanitizedData.displayName;
  sanitizedData.actorType = "platform_admin";
  sanitizedData.displayName = PLATFORM_ADMIN_DISPLAY_NAME;

  return {
    ...input,
    title: `${replacePlatformIdentity(input.title, actorUserId)} (${PLATFORM_ADMIN_DISPLAY_NAME})`,
    note: replacePlatformIdentity(input.note, actorUserId),
    data: sanitizedData,
  };
}

function findPlatformAdminActorId(data: Record<string, AuditValue> | undefined): string | undefined {
  for (const key of ["actorUserId", "actorId", "userId", "requestedByUserId"] as const) {
    const candidate = data?.[key];
    if (typeof candidate === "string" && isPlatformAdminUserSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function replacePlatformIdentity(value: string, actorUserId: string): string {
  const user = readUserSync(actorUserId);
  return [actorUserId, user?.displayName, user?.primaryEmail]
    .filter((identity): identity is string => Boolean(identity))
    .reduce((result, identity) => result.replaceAll(identity, PLATFORM_ADMIN_DISPLAY_NAME), value);
}
