// Phase 2 parity test — workspace_membership async Prisma repo vs legacy sync.
//
// Same fixture (seeded into agent_space_test) → `*Sync` and `*Async` must agree.
// Read/list paths return deep-equal `StoredWorkspaceMembershipRecord` DTOs (locks
// the joined_at→ISO / nullable→undefined fidelity rules). Void writes
// (updateRole / remove / transferOwnership) are compared via their STATE EFFECT:
// apply the sync write to one row and the async write to an equivalent row, then
// deep-equal the resulting reads. See prisma/runtime-mappers.ts for the rules.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createWorkspaceMembershipAsync,
  createWorkspaceMembershipSync,
  listUserWorkspacesAsync,
  listUserWorkspacesSync,
  listWorkspaceMembershipsAsync,
  listWorkspaceMembershipsSync,
  readWorkspaceMembershipAsync,
  readWorkspaceMembershipSync,
  removeWorkspaceMembershipAsync,
  removeWorkspaceMembershipSync,
  transferWorkspaceOwnershipAsync,
  transferWorkspaceOwnershipSync,
  updateWorkspaceMembershipRoleAsync,
  updateWorkspaceMembershipRoleSync,
  upsertWorkspaceMembershipAsync,
  upsertWorkspaceMembershipSync,
} from "./workspace-memberships.ts";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import { assertParityEqual, parityTest } from "./prisma/parity-test-harness.ts";
import { shutdownPrisma } from "./prisma/client.ts";

const WORKSPACES = [
  "wm-parity-ws-a",
  "wm-parity-ws-b",
  "wm-parity-ws-role",
  "wm-parity-ws-rm",
  "wm-parity-ws-tx-sync",
  "wm-parity-ws-tx-async",
] as const;
const USERS = [
  "wm-u1", "wm-u2", "wm-u3", "wm-u4",
  "wm-u-role-sync", "wm-u-role-async",
  "wm-u-rm-sync", "wm-u-rm-async",
  "wm-u-owner-sync", "wm-u-next-sync",
  "wm-u-owner-async", "wm-u-next-async",
] as const;

function seedWorkspace(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, `slug-${id}`, `WM Parity ${id}`);
}

function seedUser(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO users (id, display_name, created_at, updated_at, is_admin)
       VALUES (?, ?, NOW(), NOW(), 0) ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, `User ${id}`);
}

function seedMembership(
  rowId: string,
  workspaceId: string,
  userId: string,
  role: string,
  joinedAt: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', joined_at = EXCLUDED.joined_at`,
    )
    .run(rowId, workspaceId, userId, role, joinedAt);
}

function deleteMembership(workspaceId: string, userId: string): void {
  getDatabase()
    .prepare("DELETE FROM workspace_membership WHERE workspace_id = ? AND user_id = ?")
    .run(workspaceId, userId);
}

before(() => {
  resetDatabaseForTests();
  for (const ws of WORKSPACES) seedWorkspace(ws);
  for (const u of USERS) seedUser(u);
  seedMembership("wm-m1", "wm-parity-ws-a", "wm-u1", "member", "2026-08-09T10:00:00.000Z");
  seedMembership("wm-m2", "wm-parity-ws-a", "wm-u2", "admin", "2026-08-09T09:00:00.000Z");
  seedMembership("wm-role-sync", "wm-parity-ws-role", "wm-u-role-sync", "member", "2026-08-09T10:00:00.000Z");
  seedMembership("wm-role-async", "wm-parity-ws-role", "wm-u-role-async", "member", "2026-08-09T10:00:00.000Z");
  seedMembership("wm-rm-sync", "wm-parity-ws-rm", "wm-u-rm-sync", "member", "2026-08-09T10:00:00.000Z");
  seedMembership("wm-rm-async", "wm-parity-ws-rm", "wm-u-rm-async", "member", "2026-08-09T10:00:00.000Z");
  seedMembership("wm-tx-sync-owner", "wm-parity-ws-tx-sync", "wm-u-owner-sync", "owner", "2026-08-09T08:00:00.000Z");
  seedMembership("wm-tx-sync-next", "wm-parity-ws-tx-sync", "wm-u-next-sync", "member", "2026-08-09T09:00:00.000Z");
  seedMembership("wm-tx-async-owner", "wm-parity-ws-tx-async", "wm-u-owner-async", "owner", "2026-08-09T08:00:00.000Z");
  seedMembership("wm-tx-async-next", "wm-parity-ws-tx-async", "wm-u-next-async", "member", "2026-08-09T09:00:00.000Z");
});

after(async () => {
  for (const ws of WORKSPACES) {
    getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(ws);
  }
  for (const u of USERS) {
    getDatabase().prepare("DELETE FROM users WHERE id = ?").run(u);
  }
  await shutdownPrisma();
  resetDatabaseForTests();
});

parityTest("readWorkspaceMembership by workspaceId+userId", {
  sync: () => readWorkspaceMembershipSync("wm-parity-ws-a", "wm-u1"),
  async: () => readWorkspaceMembershipAsync("wm-parity-ws-a", "wm-u1"),
});

parityTest("readWorkspaceMembership missing returns null", {
  sync: () => readWorkspaceMembershipSync("wm-parity-ws-a", "wm-nonexistent"),
  async: () => readWorkspaceMembershipAsync("wm-parity-ws-a", "wm-nonexistent"),
});

parityTest("listWorkspaceMemberships (active, ordered by joinedAt ASC)", {
  sync: () => listWorkspaceMembershipsSync("wm-parity-ws-a"),
  async: () => listWorkspaceMembershipsAsync("wm-parity-ws-a"),
});

parityTest("listUserWorkspaces (active, ordered by joinedAt ASC)", {
  sync: () => listUserWorkspacesSync("wm-u1"),
  async: () => listUserWorkspacesAsync("wm-u1"),
});

// Write parity: id (randomLikeId) + joinedAt (moment of write) differ, so create
// the SAME pair sequentially (delete between) and strip those keys.
test("[parity] createWorkspaceMembership write (id + joinedAt stripped)", async () => {
  try {
    const syncRec = createWorkspaceMembershipSync({ workspaceId: "wm-parity-ws-a", userId: "wm-u3", role: "member" });
    deleteMembership("wm-parity-ws-a", "wm-u3");
    const asyncRec = await createWorkspaceMembershipAsync({ workspaceId: "wm-parity-ws-a", userId: "wm-u3", role: "member" });
    const { id: _sId, joinedAt: _sJ, ...syncRest } = syncRec;
    const { id: _aId, joinedAt: _aJ, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "createWorkspaceMembership async fields diverged from sync");
  } finally {
    deleteMembership("wm-parity-ws-a", "wm-u3");
  }
});

// Upsert parity: both operate on the same pair; second call updates. id is stable
// (upsert does not change it); only joinedAt differs.
test("[parity] upsertWorkspaceMembership write (joinedAt stripped)", async () => {
  try {
    const syncRec = upsertWorkspaceMembershipSync({ workspaceId: "wm-parity-ws-b", userId: "wm-u4", role: "admin" });
    const asyncRec = await upsertWorkspaceMembershipAsync({ workspaceId: "wm-parity-ws-b", userId: "wm-u4", role: "admin" });
    const { joinedAt: _sJ, ...syncRest } = syncRec;
    const { joinedAt: _aJ, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "upsertWorkspaceMembership async fields diverged from sync");
  } finally {
    deleteMembership("wm-parity-ws-b", "wm-u4");
  }
});

// Void-write state parity: apply sync to one row, async to an equivalent row,
// then deep-equal the reads (strip volatile id/userId/workspaceId).
test("[parity] updateWorkspaceMembershipRole state effect", async () => {
  updateWorkspaceMembershipRoleSync("wm-parity-ws-role", "wm-u-role-sync", "admin");
  await updateWorkspaceMembershipRoleAsync("wm-parity-ws-role", "wm-u-role-async", "admin");
  const syncRec = readWorkspaceMembershipSync("wm-parity-ws-role", "wm-u-role-sync");
  const asyncRec = await readWorkspaceMembershipAsync("wm-parity-ws-role", "wm-u-role-async");
  assert.ok(syncRec && asyncRec, "both roles updated");
  const { id: _s, userId: _su, joinedAt: _sj, ...syncRest } = syncRec;
  const { id: _a, userId: _au, joinedAt: _aj, ...asyncRest } = asyncRec;
  assertParityEqual(syncRest, asyncRest, "updateWorkspaceMembershipRole diverged");
  assert.equal(syncRest.role, "admin");
});

test("[parity] removeWorkspaceMembership state effect (both read null)", async () => {
  removeWorkspaceMembershipSync("wm-parity-ws-rm", "wm-u-rm-sync");
  await removeWorkspaceMembershipAsync("wm-parity-ws-rm", "wm-u-rm-async");
  const syncRec = readWorkspaceMembershipSync("wm-parity-ws-rm", "wm-u-rm-sync");
  const asyncRec = await readWorkspaceMembershipAsync("wm-parity-ws-rm", "wm-u-rm-async");
  assert.equal(syncRec, null);
  assert.equal(asyncRec, null);
});

test("[parity] transferWorkspaceOwnership state effect (demote + promote)", async () => {
  transferWorkspaceOwnershipSync("wm-parity-ws-tx-sync", "wm-u-owner-sync", "wm-u-next-sync");
  await transferWorkspaceOwnershipAsync("wm-parity-ws-tx-async", "wm-u-owner-async", "wm-u-next-async");
  const syncDemoted = readWorkspaceMembershipSync("wm-parity-ws-tx-sync", "wm-u-owner-sync");
  const asyncDemoted = await readWorkspaceMembershipAsync("wm-parity-ws-tx-async", "wm-u-owner-async");
  const syncPromoted = readWorkspaceMembershipSync("wm-parity-ws-tx-sync", "wm-u-next-sync");
  const asyncPromoted = await readWorkspaceMembershipAsync("wm-parity-ws-tx-async", "wm-u-next-async");
  assert.ok(syncDemoted && asyncDemoted && syncPromoted && asyncPromoted, "transfer completed on both sides");
  assert.equal(syncDemoted.role, "admin");
  assert.equal(asyncDemoted.role, "admin");
  assert.equal(syncPromoted.role, "owner");
  assert.equal(asyncPromoted.role, "owner");
});
