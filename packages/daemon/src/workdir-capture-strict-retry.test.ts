import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDatabase } from "@dofe-agent/db";
import { createAttachmentStorageClient, resetWorkspaceStateSync } from "@dofe-agent/services";
import { materializeHeadRevisionToWorkDirStrict } from "./workdir-capture.ts";

test("strict workspace materialization is idempotent after a partial mount retry", () => {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const workspaceId = `wdc-strict-retry-${suffix}`;
  const employeeName = "WDC Retry Worker";
  const workDir = mkdtempSync(join(tmpdir(), "dofe-wdc-strict-retry-"));
  const bytes = Buffer.from("durable workspace content\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = new Date().toISOString();
  const employeeId = `employee-${suffix}`;
  const persistentWorkspaceId = `persistent-workspace-${suffix}`;
  const revisionId = `revision-${suffix}`;

  try {
    resetWorkspaceStateSync(workspaceId);
    const db = getDatabase();
    db.prepare(
      `INSERT INTO workspace_employee (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(employeeId, workspaceId, employeeName, now, now);
    db.prepare(
      `INSERT INTO employee_persistent_workspace (
         id, workspace_id, employee_id, employee_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(persistentWorkspaceId, workspaceId, employeeId, employeeName, now, now);
    db.prepare(
      `INSERT INTO employee_workspace_revision (
         id, workspace_id, workspace_id_ref, employee_id, employee_name,
         manifest_digest, manifest_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, 'committed', ?)`,
    ).run(
      revisionId,
      workspaceId,
      persistentWorkspaceId,
      employeeId,
      employeeName,
      sha256,
      JSON.stringify({
        files: [{
          path: "repository/src/main.ts",
          sha256,
          size: bytes.byteLength,
          mediaType: "text/typescript",
          mode: "0644",
        }],
      }),
      now,
    );
    db.prepare(
      `UPDATE employee_persistent_workspace
       SET head_revision_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(revisionId, now, persistentWorkspaceId);
    createAttachmentStorageClient().putContentAddressedBlobSync({
      workspaceId,
      sha256,
      contentBytes: bytes,
      mediaType: "text/typescript",
    });

    const first = materializeHeadRevisionToWorkDirStrict(workDir, {
      workspaceId,
      employeeName,
      expectedHeadRevisionId: revisionId,
    });
    mkdirSync(join(workDir, "repository", "old"), { recursive: true });
    writeFileSync(join(workDir, "repository", "old", "obsolete.ts"), "obsolete\n");
    const retry = materializeHeadRevisionToWorkDirStrict(workDir, {
      workspaceId,
      employeeName,
      expectedHeadRevisionId: revisionId,
    });

    assert.deepEqual(first, { materializedFiles: 1, expectedFiles: 1 });
    assert.deepEqual(retry, { materializedFiles: 1, expectedFiles: 1 });
    assert.equal(existsSync(join(workDir, "repository", "old", "obsolete.ts")), false);

    writeFileSync(join(workDir, "repository/src/main.ts"), "tampered local content\n");
    assert.throws(
      () => materializeHeadRevisionToWorkDirStrict(workDir, {
        workspaceId,
        employeeName,
        expectedHeadRevisionId: revisionId,
      }),
      /existing target digest differs from the durable revision/,
    );
  } finally {
    resetWorkspaceStateSync(workspaceId);
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("strict workspace materialization rejects a symlink workspace root before touching its target", () => {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const workspaceId = `wdc-strict-root-${suffix}`;
  const employeeName = "WDC Root Guard";
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-wdc-strict-root-"));
  const externalDir = join(tempRoot, "external");
  const workDir = join(tempRoot, "workspace");
  const bytes = Buffer.from("durable workspace content\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = new Date().toISOString();
  const employeeId = `employee-${suffix}`;
  const persistentWorkspaceId = `persistent-workspace-${suffix}`;
  const revisionId = `revision-${suffix}`;

  try {
    resetWorkspaceStateSync(workspaceId);
    const db = getDatabase();
    db.prepare(
      `INSERT INTO workspace_employee (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(employeeId, workspaceId, employeeName, now, now);
    db.prepare(
      `INSERT INTO employee_persistent_workspace (
         id, workspace_id, employee_id, employee_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(persistentWorkspaceId, workspaceId, employeeId, employeeName, now, now);
    db.prepare(
      `INSERT INTO employee_workspace_revision (
         id, workspace_id, workspace_id_ref, employee_id, employee_name,
         manifest_digest, manifest_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, 'committed', ?)`,
    ).run(
      revisionId,
      workspaceId,
      persistentWorkspaceId,
      employeeId,
      employeeName,
      sha256,
      JSON.stringify({
        files: [{
          path: "repository/src/main.ts",
          sha256,
          size: bytes.byteLength,
          mediaType: "text/typescript",
          mode: "0644",
        }],
      }),
      now,
    );
    db.prepare(
      `UPDATE employee_persistent_workspace SET head_revision_id = ?, updated_at = ? WHERE id = ?`,
    ).run(revisionId, now, persistentWorkspaceId);
    createAttachmentStorageClient().putContentAddressedBlobSync({
      workspaceId,
      sha256,
      contentBytes: bytes,
      mediaType: "text/typescript",
    });
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, "sentinel.txt"), "do not touch\n");
    symlinkSync(externalDir, workDir, "dir");

    assert.throws(
      () => materializeHeadRevisionToWorkDirStrict(workDir, {
        workspaceId,
        employeeName,
        expectedHeadRevisionId: revisionId,
      }),
      /workspace root.*real directory/i,
    );
    assert.equal(readFileSync(join(externalDir, "sentinel.txt"), "utf8"), "do not touch\n");
    assert.equal(existsSync(join(externalDir, "repository")), false);
  } finally {
    resetWorkspaceStateSync(workspaceId);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
