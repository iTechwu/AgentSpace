import { isDaemonProvider, type DaemonProvider } from "@dofe-agent/domain";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  ProviderAccountRecord,
  ProviderAccountStatus,
  RuntimeProvisionRequestRecord,
  RuntimeProvisionRequestStatus,
} from "./types.ts";

export function createProviderAccountSync(input: {
  workspaceId?: string;
  provider: DaemonProvider;
  name: string;
  billingAccountId?: string;
  secretRef?: string;
  configRef?: string;
  allowedModels?: string[];
  createdBy: string;
}): ProviderAccountRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const provider = assertProvider(input.provider);
  const name = required(input.name, "name");
  const secretRef = optional(input.secretRef);
  const configRef = optional(input.configRef);
  if (!secretRef && !configRef) {
    throw new Error("provider_account.configuration_reference_required");
  }
  const now = new Date().toISOString();
  const id = `provider-account-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO provider_account (
      id, workspace_id, provider, name, billing_account_id, secret_ref, config_ref,
      allowed_models_json, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(id, workspaceId, provider, name, optional(input.billingAccountId), secretRef, configRef, JSON.stringify(normalizeModels(input.allowedModels)), input.createdBy.trim(), now, now);
  return readProviderAccountSync(id, workspaceId)!;
}

export function listProviderAccountsSync(workspaceId = DEFAULT_WORKSPACE_ID): ProviderAccountRecord[] {
  const rows = getDatabase().prepare("SELECT * FROM provider_account WHERE workspace_id = ? ORDER BY provider, name").all(workspaceId) as RawProviderAccount[];
  return rows.map(mapProviderAccount);
}

export function readProviderAccountSync(id: string, workspaceId?: string): ProviderAccountRecord | null {
  const row = (workspaceId
    ? getDatabase().prepare("SELECT * FROM provider_account WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
    : getDatabase().prepare("SELECT * FROM provider_account WHERE id = ?").get(id)) as RawProviderAccount | undefined;
  return row ? mapProviderAccount(row) : null;
}

export function updateProviderAccountStatusSync(id: string, status: Exclude<ProviderAccountStatus, "legacy">, workspaceId = DEFAULT_WORKSPACE_ID): ProviderAccountRecord | null {
  getDatabase().prepare("UPDATE provider_account SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status <> 'legacy'")
    .run(status, new Date().toISOString(), id, workspaceId);
  return readProviderAccountSync(id, workspaceId);
}

export function ensureLegacyProviderAccountSync(workspaceId: string, provider: DaemonProvider): ProviderAccountRecord {
  const existing = getDatabase().prepare(
    "SELECT * FROM provider_account WHERE workspace_id = ? AND provider = ? AND status = 'legacy' LIMIT 1",
  ).get(workspaceId, provider) as RawProviderAccount | undefined;
  if (existing) return mapProviderAccount(existing);
  const now = new Date().toISOString();
  const id = `provider-account-legacy-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO provider_account (id, workspace_id, provider, name, allowed_models_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'legacy', 'system', ?, ?)`,
  ).run(id, workspaceId, provider, `Legacy ${provider} account`, now, now);
  return readProviderAccountSync(id, workspaceId)!;
}

export function assertActiveProviderAccountSync(input: { id?: string; workspaceId: string; provider: DaemonProvider }): ProviderAccountRecord {
  const account = input.id
    ? readProviderAccountSync(input.id, input.workspaceId)
    : readDefaultProviderAccountSync(input.workspaceId, input.provider);
  if (!account || account.provider !== input.provider || account.status === "inactive") {
    throw new Error("provider_account.invalid_for_runtime");
  }
  return account;
}

function readDefaultProviderAccountSync(workspaceId: string, provider: DaemonProvider): ProviderAccountRecord {
  const activeAccount = getDatabase().prepare(
    "SELECT * FROM provider_account WHERE workspace_id = ? AND provider = ? AND status = 'active' LIMIT 1",
  ).get(workspaceId, provider) as RawProviderAccount | undefined;
  if (activeAccount) {
    throw new Error("provider_account.required_for_runtime");
  }
  return ensureLegacyProviderAccountSync(workspaceId, provider);
}

export function createRuntimeProvisionRequestSync(input: {
  workspaceId?: string;
  providerAccountId: string;
  provider: DaemonProvider;
  runtimeName: string;
  targetServer: string;
  requestedBy: string;
}): RuntimeProvisionRequestRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const provider = assertProvider(input.provider);
  assertActiveProviderAccountSync({ id: input.providerAccountId, workspaceId, provider });
  const now = new Date().toISOString();
  const id = `runtime-provision-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO runtime_provision_request (
      id, workspace_id, provider_account_id, provider, runtime_name, target_server, status, requested_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
  ).run(id, workspaceId, input.providerAccountId, provider, required(input.runtimeName, "runtimeName"), required(input.targetServer, "targetServer"), required(input.requestedBy, "requestedBy"), now, now);
  return readRuntimeProvisionRequestSync(id, workspaceId)!;
}

export function listRuntimeProvisionRequestsSync(workspaceId = DEFAULT_WORKSPACE_ID): RuntimeProvisionRequestRecord[] {
  const rows = getDatabase().prepare("SELECT * FROM runtime_provision_request WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as RawProvisionRequest[];
  return rows.map(mapProvisionRequest);
}

export function readRuntimeProvisionRequestSync(id: string, workspaceId?: string): RuntimeProvisionRequestRecord | null {
  const row = (workspaceId
    ? getDatabase().prepare("SELECT * FROM runtime_provision_request WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
    : getDatabase().prepare("SELECT * FROM runtime_provision_request WHERE id = ?").get(id)) as RawProvisionRequest | undefined;
  return row ? mapProvisionRequest(row) : null;
}

export function updateRuntimeProvisionRequestSync(input: {
  id: string;
  workspaceId?: string;
  status: RuntimeProvisionRequestStatus;
  expectedStatus?: RuntimeProvisionRequestStatus;
  actorUserId?: string;
  daemonTokenId?: string;
}): RuntimeProvisionRequestRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const approvedBy = input.status === "approved" ? optional(input.actorUserId) : null;
  const result = getDatabase().prepare(
    `UPDATE runtime_provision_request
     SET status = ?, approved_by = COALESCE(?, approved_by), daemon_token_id = COALESCE(?, daemon_token_id), updated_at = ?
     WHERE id = ? AND workspace_id = ?${input.expectedStatus ? " AND status = ?" : ""}`,
  ).run(input.status, approvedBy, optional(input.daemonTokenId), new Date().toISOString(), input.id, workspaceId, ...(input.expectedStatus ? [input.expectedStatus] : []));
  if (result.changes !== 1) return null;
  return readRuntimeProvisionRequestSync(input.id, workspaceId);
}

export function fulfillRuntimeProvisionRequestsForDaemonTokenSync(input: {
  workspaceId: string;
  daemonTokenId?: string;
  provider: DaemonProvider;
  providerAccountId: string;
}): void {
  if (!input.daemonTokenId) return;
  getDatabase().prepare(
    `UPDATE runtime_provision_request
     SET status = 'fulfilled', updated_at = ?
     WHERE workspace_id = ?
       AND daemon_token_id = ?
       AND provider = ?
       AND provider_account_id = ?
       AND status = 'approved'`,
  ).run(new Date().toISOString(), input.workspaceId, input.daemonTokenId, input.provider, input.providerAccountId);
}

type RawProviderAccount = { id: string; workspace_id: string; provider: string; name: string; billing_account_id: string | null; secret_ref: string | null; config_ref: string | null; allowed_models_json: string; status: ProviderAccountStatus; created_by: string; created_at: string; updated_at: string };
type RawProvisionRequest = { id: string; workspace_id: string; provider_account_id: string; provider: string; runtime_name: string; target_server: string; status: RuntimeProvisionRequestStatus; requested_by: string; approved_by: string | null; daemon_token_id: string | null; created_at: string; updated_at: string };

function mapProviderAccount(row: RawProviderAccount): ProviderAccountRecord {
  return { id: row.id, workspaceId: row.workspace_id, provider: assertProvider(row.provider), name: row.name, billingAccountId: row.billing_account_id ?? undefined, secretRef: row.secret_ref ?? undefined, configRef: row.config_ref ?? undefined, allowedModels: normalizeModels(parseJsonArray(row.allowed_models_json)), status: row.status, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapProvisionRequest(row: RawProvisionRequest): RuntimeProvisionRequestRecord {
  return { id: row.id, workspaceId: row.workspace_id, providerAccountId: row.provider_account_id, provider: assertProvider(row.provider), runtimeName: row.runtime_name, targetServer: row.target_server, status: row.status, requestedBy: row.requested_by, approvedBy: row.approved_by ?? undefined, daemonTokenId: row.daemon_token_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}
function assertProvider(value: string): DaemonProvider { if (!isDaemonProvider(value)) throw new Error("provider is invalid."); return value; }
function required(value: string, label: string): string { const result = value.trim(); if (!result) throw new Error(`${label} is required.`); return result; }
function optional(value: string | undefined): string | null { const result = value?.trim(); return result || null; }
function parseJsonArray(value: string): unknown[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function normalizeModels(values: unknown): string[] { return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))] : []; }
