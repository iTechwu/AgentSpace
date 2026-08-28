import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import {
  createEmployeeDataLegalHoldSync,
  exportEmployeeDataLegalHoldProofSync,
  releaseEmployeeDataLegalHoldSync,
} from "./index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM employee_data_legal_hold").run();
    db.prepare("DELETE FROM employee_persistent_workspace").run();
    db.prepare("DELETE FROM workspace_employee").run();
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(DEFAULT_WORKSPACE_ID, "default", "test", now, now);
  });
});

function seedEmployeeWorkspace(): { employeeId: string; workspaceId: string } {
  const db = getDatabase();
  const now = new Date().toISOString();
  const employeeId = `emp-${randomLikeId()}`;
  const workspaceId = `ws-${randomLikeId()}`;
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO workspace_employee (id, workspace_id, name, role, created_at, updated_at)
       VALUES (?, 'default', ?, 'Agent', ?, ?)`,
    ).run(employeeId, "Alice", now, now);
    db.prepare(
      `INSERT INTO employee_persistent_workspace (id, workspace_id, employee_id, employee_name, created_at, updated_at)
       VALUES (?, 'default', ?, 'Alice', ?, ?)`,
    ).run(workspaceId, employeeId, now, now);
  });
  return { employeeId, workspaceId };
}

test("legal hold stores a case reference and export produces a tamper-evident proof", () => {
  const { employeeId, workspaceId } = seedEmployeeWorkspace();
  const hold = createEmployeeDataLegalHoldSync({
    workspaceId: "default",
    employeeId,
    resourceType: "employee_workspace",
    resourceId: workspaceId,
    reason: "litigation preservation",
    caseReference: "LEG-2026-0142",
    createdByUserId: "legal-admin",
    createdByDisplayName: "Legal Admin",
  });
  assert.equal(hold.caseReference, "LEG-2026-0142");

  const proof = exportEmployeeDataLegalHoldProofSync({ workspaceId: "default" });
  assert.equal(proof.holds.length, 1);
  assert.equal(proof.holds[0]!.caseReference, "LEG-2026-0142");
  assert.equal(proof.proofDigest.length, 64, "export binds a tamper-evident sha256");

  // Released holds are excluded from the active proof.
  releaseEmployeeDataLegalHoldSync({
    id: hold.id,
    workspaceId: "default",
    releasedByUserId: "legal-admin",
    releaseReason: "matter closed",
  });
  const afterRelease = exportEmployeeDataLegalHoldProofSync({ workspaceId: "default" });
  assert.equal(afterRelease.holds.length, 0);
});
