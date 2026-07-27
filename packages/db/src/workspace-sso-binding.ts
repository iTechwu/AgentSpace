import { getDatabase } from "./database.ts";
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
