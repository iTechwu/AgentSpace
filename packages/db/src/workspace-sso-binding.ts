import { getDatabase } from "./database.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { toIsoString, toOptionalString } from "./prisma/runtime-mappers.ts";
import type {
  WorkspaceSsoBindingRecord,
  WorkspaceSsoBindingSource,
} from "./types.ts";

export interface UpsertWorkspaceSsoBindingInput {
  workspaceId: string;
  tenantId: string;
  tenantSlug?: string;
  tenantName: string;
  teamId?: string;
  teamSlug?: string;
  teamName?: string;
  source: WorkspaceSsoBindingSource;
}

/**
 * Persist the SSO tenant/team scope for a workspace so managed-runtime
 * provisioning can resolve the models.dofe.ai tenantId/teamId. Called from
 * the SSO workspace sync (`syncSsoWorkspacesForUserSync`).
 */
export function upsertWorkspaceSsoBindingSync(
  input: UpsertWorkspaceSsoBindingInput,
): WorkspaceSsoBindingRecord {
  const teamId = optional(input.teamId);
  getDatabase().prepare(
    `INSERT INTO workspace_sso_binding (
       workspace_id, tenant_id, tenant_slug, tenant_name,
       team_id, team_slug, team_name, source, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       tenant_slug = EXCLUDED.tenant_slug,
       tenant_name = EXCLUDED.tenant_name,
       team_id = EXCLUDED.team_id,
       team_slug = EXCLUDED.team_slug,
       team_name = EXCLUDED.team_name,
       source = EXCLUDED.source,
       synced_at = EXCLUDED.synced_at`,
  ).run(
    input.workspaceId,
    input.tenantId,
    optional(input.tenantSlug),
    input.tenantName,
    teamId,
    optional(input.teamSlug),
    optional(input.teamName),
    input.source,
    new Date().toISOString(),
  );
  return readWorkspaceSsoBindingSync(input.workspaceId)!;
}

export function readWorkspaceSsoBindingSync(
  workspaceId: string,
): WorkspaceSsoBindingRecord | null {
  const row = getDatabase().prepare(
    "SELECT * FROM workspace_sso_binding WHERE workspace_id = ?",
  ).get(workspaceId) as RawWorkspaceSsoBinding | undefined;
  return row ? mapWorkspaceSsoBinding(row) : null;
}

export function listWorkspaceSsoBindingsSync(): WorkspaceSsoBindingRecord[] {
  const rows = getDatabase().prepare(
    "SELECT * FROM workspace_sso_binding ORDER BY workspace_id",
  ).all() as RawWorkspaceSsoBinding[];
  return rows.map(mapWorkspaceSsoBinding);
}

type RawWorkspaceSsoBinding = {
  workspace_id: string;
  tenant_id: string;
  tenant_slug: string | null;
  tenant_name: string;
  team_id: string | null;
  team_slug: string | null;
  team_name: string | null;
  source: WorkspaceSsoBindingSource;
  synced_at: string;
};

function mapWorkspaceSsoBinding(
  row: RawWorkspaceSsoBinding,
): WorkspaceSsoBindingRecord {
  return {
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug ?? undefined,
    tenantName: row.tenant_name,
    teamId: row.team_id ?? undefined,
    teamSlug: row.team_slug ?? undefined,
    teamName: row.team_name ?? undefined,
    source: row.source,
    syncedAt: row.synced_at,
  };
}

function optional(value: string | undefined): string | null {
  const result = value?.trim();
  return result || null;
}

// ---------------------------------------------------------------------------
// Phase 2 async Prisma repository (Route B).
//
// Coexists with the *Sync functions above and returns the SAME
// `WorkspaceSsoBindingRecord` DTO. FIDELITY READS use `$queryRawUnsafe` with a
// `synced_at::text` cast — @prisma/adapter-pg relabels timestamptz offsets
// without shifting wall-clock digits (wrong under a non-UTC PG session), so
// `synced_at` is selected as text and fed through `toIsoString`, which mirrors
// the legacy sync worker's `new Date(rawText).toISOString()`. See
// prisma/runtime-mappers.ts for the full rationale. Identifiers are a hardcoded
// whitelist; only values are parameterized (`$1..$N`).
// ---------------------------------------------------------------------------

/**
 * Row shape from the fidelity read. `synced_at` arrives as the raw `::text`
 * cast (not Prisma's Date) so the mapper reproduces the sync worker's output.
 */
type PrismaWorkspaceSsoBindingRow = {
  workspace_id: string;
  tenant_id: string;
  tenant_slug: string | null;
  tenant_name: string;
  team_id: string | null;
  team_slug: string | null;
  team_name: string | null;
  source: string;
  synced_at: string;
};

/** Shared column list with the fidelity cast on the timestamp column. */
const WORKSPACE_SSO_BINDING_SELECT_COLUMNS =
  "workspace_id, tenant_id, tenant_slug, tenant_name, team_id, team_slug, team_name, source, synced_at::text AS synced_at";

export async function readWorkspaceSsoBindingAsync(
  workspaceId: string,
): Promise<WorkspaceSsoBindingRecord | null> {
  const sql = `SELECT ${WORKSPACE_SSO_BINDING_SELECT_COLUMNS} FROM workspace_sso_binding WHERE workspace_id = $1`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceSsoBindingRow[]>(sql, workspaceId);
  return rows.length > 0 ? mapWorkspaceSsoBindingFromPrisma(rows[0]!) : null;
}

export async function listWorkspaceSsoBindingsAsync(): Promise<WorkspaceSsoBindingRecord[]> {
  const sql = `SELECT ${WORKSPACE_SSO_BINDING_SELECT_COLUMNS} FROM workspace_sso_binding ORDER BY workspace_id`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceSsoBindingRow[]>(sql);
  return rows.map(mapWorkspaceSsoBindingFromPrisma);
}

export async function upsertWorkspaceSsoBindingAsync(
  input: UpsertWorkspaceSsoBindingInput,
): Promise<WorkspaceSsoBindingRecord> {
  const now = new Date().toISOString();
  const teamId = optional(input.teamId);
  // Raw INSERT ... ON CONFLICT: synced_at is timestamptz. Typed Prisma `new Date()`
  // shifts under a non-UTC session (see user-auth fix); ISO string mirrors sync.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO workspace_sso_binding (
       workspace_id, tenant_id, tenant_slug, tenant_name,
       team_id, team_slug, team_name, source, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(workspace_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       tenant_slug = EXCLUDED.tenant_slug,
       tenant_name = EXCLUDED.tenant_name,
       team_id = EXCLUDED.team_id,
       team_slug = EXCLUDED.team_slug,
       team_name = EXCLUDED.team_name,
       source = EXCLUDED.source,
       synced_at = EXCLUDED.synced_at`,
    input.workspaceId,
    input.tenantId,
    optional(input.tenantSlug),
    input.tenantName,
    teamId,
    optional(input.teamSlug),
    optional(input.teamName),
    input.source,
    now,
  );
  // Re-read via the fidelity text-cast path (mirrors upsertWorkspaceSsoBindingSync,
  // which INSERTs/ON CONFLICT then readWorkspaceSsoBindingSync). This returns the
  // normalized ISO timestamp rather than the adapter's Date shape.
  const record = await readWorkspaceSsoBindingAsync(input.workspaceId);
  if (!record) {
    throw new Error(
      `upsertWorkspaceSsoBindingAsync: workspace_sso_binding row ${input.workspaceId} missing immediately after upsert`,
    );
  }
  return record;
}

function mapWorkspaceSsoBindingFromPrisma(
  row: PrismaWorkspaceSsoBindingRow,
): WorkspaceSsoBindingRecord {
  return {
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    tenantSlug: toOptionalString(row.tenant_slug),
    tenantName: row.tenant_name,
    teamId: toOptionalString(row.team_id),
    teamSlug: toOptionalString(row.team_slug),
    teamName: toOptionalString(row.team_name),
    source: row.source as WorkspaceSsoBindingSource,
    syncedAt: toIsoString(row.synced_at) ?? "",
  };
}
