import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { createEmployeeSync, resetWorkspaceStateSync } from "@dofe-agent/services";
import { materializeHeadRevisionToWorkDir } from "./workdir-capture.ts";

const WORKSPACE_ID = "wdc-materialize-test";

let tempRoot: string;

before(() => {
  process.env.NODE_ENV = "test";
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

beforeEach(() => {
  resetWorkspaceStateSync(WORKSPACE_ID);
  tempRoot = mkdtempSync(join(tmpdir(), "dofe-wdc-materialize-"));
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function seedHeadRevision(manifestJson: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const suffix = now.replace(/[^0-9]/g, "");
  db.prepare(
    `INSERT INTO workspace_employee (workspace_id, name, created_at, updated_at)
     VALUES (?, 'WDC Worker', ?, ?)`,
  ).run(WORKSPACE_ID, now, now);
  const employee = db.prepare(
    `SELECT id FROM workspace_employee WHERE workspace_id = ? AND name = ?`,
  ).get(WORKSPACE_ID, "WDC Worker") as { id: string };
  const employeeId = employee.id;
  db.prepare(
    `INSERT INTO employee_persistent_workspace (id, workspace_id, employee_id, employee_name, created_at, updated_at)
     VALUES (?, ?, ?, 'WDC Worker', ?, ?)`,
  ).run(`wdc-ws-${suffix}`, WORKSPACE_ID, employeeId, now, now);
  db.prepare(
    `INSERT INTO employee_workspace_revision (id, workspace_id, workspace_id_ref, employee_id, employee_name, manifest_digest, manifest_json, status, created_at)
     VALUES (?, ?, ?, ?, 'WDC Worker', 'digest', ?::jsonb, 'committed', ?)`,
  ).run(`rev-${suffix}`, WORKSPACE_ID, `wdc-ws-${suffix}`, employeeId, manifestJson, now);
  db.prepare(
    `UPDATE employee_persistent_workspace SET head_revision_id = ?, updated_at = ? WHERE id = ?`,
  ).run(`rev-${suffix}`, now, `wdc-ws-${suffix}`);
}

test("materializeHeadRevisionToWorkDir reports degraded for a structurally invalid manifest", () => {
  // Valid JSON but NOT a revision manifest (no `files` array) — the parser must
  // treat it as unreadable instead of silently returning 0/0 success.
  seedHeadRevision("{}");

  const result = materializeHeadRevisionToWorkDir(tempRoot, {
    workspaceId: WORKSPACE_ID,
    employeeName: "WDC Worker",
  });
  assert.equal(result.materializedFiles, 0);
  assert.ok(result.missingBlobs >= 1, "invalid manifest must surface as a degraded workspace");
});

test("materializeHeadRevisionToWorkDir counts a missing blob instead of silently succeeding", () => {
  // Manifest declares one file whose blob does not exist anywhere in storage.
  seedHeadRevision(JSON.stringify({
    files: [{ path: "repository/src/main.ts", sha256: "f".repeat(64), size: 4, mediaType: "text/typescript" }],
  }));

  const result = materializeHeadRevisionToWorkDir(tempRoot, {
    workspaceId: WORKSPACE_ID,
    employeeName: "WDC Worker",
  });
  assert.equal(result.materializedFiles, 0);
  assert.equal(result.missingBlobs, 1);
});

test("an existing local file cannot hide a missing durable blob", () => {
  seedHeadRevision(JSON.stringify({
    files: [{ path: "repository/src/main.ts", sha256: "d".repeat(64), size: 4, mediaType: "text/typescript" }],
  }));
  mkdirSync(join(tempRoot, "repository/src"), { recursive: true });
  writeFileSync(join(tempRoot, "repository/src/main.ts"), "stale local copy");

  const result = materializeHeadRevisionToWorkDir(tempRoot, {
    workspaceId: WORKSPACE_ID,
    employeeName: "WDC Worker",
  });
  assert.equal(result.materializedFiles, 0);
  assert.equal(result.missingBlobs, 1);
});
