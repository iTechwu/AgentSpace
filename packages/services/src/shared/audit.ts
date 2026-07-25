import type { LedgerItem } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "./state-io.ts";

const MAX_AUDIT_LEDGER_ENTRIES = 200;

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
    recordWorkspaceAuditEventSync(input);
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
