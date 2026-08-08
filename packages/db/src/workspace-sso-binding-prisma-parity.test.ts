// Phase 2 parity test — workspace_sso_binding async Prisma repo vs legacy sync.
//
// Same fixture (seeded into agent_space_test) → `*Sync` and `*Async` must return
// deep-equal `WorkspaceSsoBindingRecord` DTOs. Locks the fidelity rule the
// migration depends on: timestamptz `synced_at`→ISO string, nullable→undefined
// (see prisma/runtime-mappers.ts). If the async repo ever returns a Date or
// null, the deepEqual here fails and points at the missing mapper.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  listWorkspaceSsoBindingsAsync,
  listWorkspaceSsoBindingsSync,
  readWorkspaceSsoBindingAsync,
  readWorkspaceSsoBindingSync,
  upsertWorkspaceSsoBindingAsync,
  upsertWorkspaceSsoBindingSync,
  type UpsertWorkspaceSsoBindingInput,
} from "./workspace-sso-binding.ts";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import { assertParityEqual, parityTest } from "./prisma/parity-test-harness.ts";
import { shutdownPrisma } from "./prisma/client.ts";

const WORKSPACES = ["ws-sso-parity-1", "ws-sso-parity-2", "ws-sso-parity-3"] as const;

function seedWorkspace(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, `slug-${id}`, `SSO Parity ${id}`);
}

function seedBinding(
  workspaceId: string,
  tenantId: string,
  tenantName: string,
  source: "team" | "tenant",
  teamId: string | null,
  syncedAt: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace_sso_binding
         (workspace_id, tenant_id, tenant_slug, tenant_name, team_id, team_slug, team_name, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, tenant_name = EXCLUDED.tenant_name,
         team_id = EXCLUDED.team_id, source = EXCLUDED.source, synced_at = EXCLUDED.synced_at`,
    )
    .run(workspaceId, tenantId, null, tenantName, teamId, null, teamId ? `team-${tenantId}` : null, source, syncedAt);
}

before(() => {
  resetDatabaseForTests();
  for (const ws of WORKSPACES) seedWorkspace(ws);
  // Distinct synced_at so list ordering by workspace_id is deterministic; varied
  // source/team to exercise both the tenant-only and team-scoped shapes.
  seedBinding("ws-sso-parity-1", "sso-parity-tenant-1", "Tenant One", "tenant", null, "2026-08-09T10:00:00.000Z");
  seedBinding("ws-sso-parity-2", "sso-parity-tenant-2", "Tenant Two", "team", "sso-parity-team-2", "2026-08-09T11:00:00.000Z");
});

after(async () => {
  for (const ws of WORKSPACES) {
    getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(ws);
  }
  await shutdownPrisma();
  resetDatabaseForTests();
});

parityTest("readWorkspaceSsoBinding by workspaceId", {
  sync: () => readWorkspaceSsoBindingSync("ws-sso-parity-1"),
  async: () => readWorkspaceSsoBindingAsync("ws-sso-parity-1"),
});

parityTest("readWorkspaceSsoBinding team-scoped (nullable team fields present)", {
  sync: () => readWorkspaceSsoBindingSync("ws-sso-parity-2"),
  async: () => readWorkspaceSsoBindingAsync("ws-sso-parity-2"),
});

parityTest("readWorkspaceSsoBinding missing returns null", {
  sync: () => readWorkspaceSsoBindingSync("ws-sso-parity-missing"),
  async: () => readWorkspaceSsoBindingAsync("ws-sso-parity-missing"),
});

test("[parity] readWorkspaceSsoBinding DTO fidelity: syncedAt is ISO string", async () => {
  const syncRec = readWorkspaceSsoBindingSync("ws-sso-parity-1");
  const asyncRec = await readWorkspaceSsoBindingAsync("ws-sso-parity-1");
  assert.equal(typeof asyncRec?.syncedAt, "string", "syncedAt must be ISO string, not Date");
  assert.equal(asyncRec?.syncedAt, syncRec?.syncedAt, "ISO timestamps must match");
});

parityTest("listWorkspaceSsoBindings (full table, ordered by workspaceId)", {
  sync: () => listWorkspaceSsoBindingsSync(),
  async: () => listWorkspaceSsoBindingsAsync(),
});

// Write parity: syncedAt (moment of write) legitimately differs, so strip it and
// compare the rest — this still proves both writes store identical scope fields.
test("[parity] upsertWorkspaceSsoBinding write (syncedAt stripped)", async () => {
  const base: UpsertWorkspaceSsoBindingInput = {
    workspaceId: "ws-sso-parity-3",
    tenantId: "sso-parity-tenant-3",
    tenantName: "Tenant Three",
    source: "team",
    teamId: "sso-parity-team-3",
    teamName: "Team Three",
  };
  try {
    const syncRec = upsertWorkspaceSsoBindingSync(base);
    const asyncRec = await upsertWorkspaceSsoBindingAsync({ ...base, teamName: "Team Three" });
    const { syncedAt: _syncTs, ...syncRest } = syncRec;
    const { syncedAt: _asyncTs, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "upsertWorkspaceSsoBinding async fields diverged from sync");
  } finally {
    getDatabase().prepare("DELETE FROM workspace_sso_binding WHERE workspace_id = ?").run("ws-sso-parity-3");
  }
});
