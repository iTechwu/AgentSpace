// Phase 2 parity test — audit_log async Prisma repo vs legacy sync repo.
//
// Same fixture (seeded into agent_space_test) → `*Sync` and `*Async` must return
// deep-equal `AuditLogRecord` DTOs. This locks the fidelity rules the migration
// depends on: timestamptz→ISO string, jsonb→JSON string, nullable→undefined
// (see prisma/runtime-mappers.ts). If a future change makes the async repo
// return a Date / object / null, the deepEqual here fails and points at the
// missing mapper. README §4 mandates one such comparison test per migrated fn.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  listAuditLogsAsync,
  listAuditLogsSync,
  readAuditLogAsync,
  readAuditLogSync,
  recordAuditLogAsync,
  recordAuditLogSync,
  type RecordAuditLogInput,
} from "./audit-log.ts";
import { DEFAULT_WORKSPACE_ID, getDatabase, resetDatabaseForTests } from "./database.ts";
import { assertParityEqual, parityTest } from "./prisma/parity-test-harness.ts";
import { shutdownPrisma } from "./prisma/client.ts";

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const TAG = "PARITY_2026";
const SEED_IDS = ["audit-parity-1", "audit-parity-2", "audit-parity-3"] as const;

function seedRow(id: string, dataJson: string, createdAt: string): void {
  getDatabase().prepare(
    `INSERT INTO audit_log (id, workspace_id, title, note, code, data_json, source, source_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, WORKSPACE, `title-${id}`, `note-${id}`, TAG, dataJson, "runtime_lifecycle", 0, createdAt);
}

before(() => {
  resetDatabaseForTests();
  // Distinct created_at so ORDER BY created_at DESC is deterministic (3 → 2 → 1).
  // Varied jsonb so the actorId / runtimeId extraction filters are exercised.
  seedRow("audit-parity-1", JSON.stringify({ actorId: "u1", runtimeId: "r1" }), "2026-08-08T10:00:00.000Z");
  seedRow("audit-parity-2", JSON.stringify({ actorId: "u2", runtimeId: "r2" }), "2026-08-08T11:00:00.000Z");
  seedRow("audit-parity-3", JSON.stringify({ actorId: "u1", runtimeId: "r3" }), "2026-08-08T12:00:00.000Z");
});

after(async () => {
  for (const id of SEED_IDS) {
    getDatabase().prepare("DELETE FROM audit_log WHERE id = ?").run(id);
  }
  await shutdownPrisma();
  resetDatabaseForTests();
});

parityTest("readAuditLog by id", {
  sync: () => readAuditLogSync("audit-parity-2"),
  async: () => readAuditLogAsync("audit-parity-2"),
});

parityTest("readAuditLog by id + workspaceId", {
  sync: () => readAuditLogSync("audit-parity-2", WORKSPACE),
  async: () => readAuditLogAsync("audit-parity-2", WORKSPACE),
});

parityTest("readAuditLog missing id returns null", {
  sync: () => readAuditLogSync("audit-parity-missing"),
  async: () => readAuditLogAsync("audit-parity-missing"),
});

test("[parity] readAuditLog DTO fidelity: createdAt is ISO string, dataJson is string", async () => {
  const syncRec = readAuditLogSync("audit-parity-1");
  const asyncRec = await readAuditLogAsync("audit-parity-1");
  assert.equal(typeof asyncRec?.createdAt, "string", "createdAt must be ISO string, not Date");
  assert.equal(typeof asyncRec?.dataJson, "string", "dataJson must be JSON string, not object");
  assert.equal(asyncRec?.createdAt, syncRec?.createdAt, "ISO timestamps must match");
  assert.equal(asyncRec?.dataJson, syncRec?.dataJson, "JSON strings must match");
});

parityTest("listAuditLogs by code tag (ordered DESC)", {
  sync: () => listAuditLogsSync(WORKSPACE, { code: TAG }),
  async: () => listAuditLogsAsync(WORKSPACE, { code: TAG }),
});

parityTest("listAuditLogs jsonb actorId filter (COALESCE path)", {
  sync: () => listAuditLogsSync(WORKSPACE, { code: TAG, actorId: "u1" }),
  async: () => listAuditLogsAsync(WORKSPACE, { code: TAG, actorId: "u1" }),
});

parityTest("listAuditLogs jsonb runtimeId filter", {
  sync: () => listAuditLogsSync(WORKSPACE, { code: TAG, runtimeId: "r2" }),
  async: () => listAuditLogsAsync(WORKSPACE, { code: TAG, runtimeId: "r2" }),
});

parityTest("listAuditLogs createdFrom + limit", {
  sync: () => listAuditLogsSync(WORKSPACE, { code: TAG, createdFrom: "2026-08-08T11:30:00.000Z", limit: 5 }),
  async: () => listAuditLogsAsync(WORKSPACE, { code: TAG, createdFrom: "2026-08-08T11:30:00.000Z", limit: 5 }),
});

// Write parity: ids (randomLikeId) and timestamps (moment of write) legitimately
// differ, so strip those keys and compare the rest — this still proves both
// writes store identical title/note/code/source/source_index/data_json.
test("[parity] recordAuditLog write (id + createdAt stripped)", async () => {
  const input: RecordAuditLogInput = {
    workspaceId: WORKSPACE,
    title: "parity-write",
    note: "parity-note",
    code: "PARITY_WRITE",
    source: "runtime_lifecycle",
    data: { actorId: "w1", count: 3, nested: { ok: true } },
  };
  try {
    const syncRec = recordAuditLogSync(input);
    const asyncRec = await recordAuditLogAsync(input);
    const { id: _syncId, createdAt: _syncTs, ...syncRest } = syncRec;
    const { id: _asyncId, createdAt: _asyncTs, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "recordAuditLog async fields diverged from sync");
  } finally {
    // Clean up the two rows this case created (random ids — capture via code tag).
    getDatabase().prepare("DELETE FROM audit_log WHERE code = 'PARITY_WRITE'").run();
  }
});
