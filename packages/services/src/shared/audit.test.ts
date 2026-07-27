import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, isPlatformAdminUserSync, listAuditLogsSync } from "@dofe-agent/db";
import { readWorkspaceStateSync } from "./state-io.ts";
import { PLATFORM_AUDIT_WORKSPACE_ID, tryRecordWorkspaceAuditEventSync } from "./audit.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-platform-audit-"));
const PLATFORM_USER_ID = "platform-user-1";
const TARGET_WORKSPACE_ID = "sso-team-audit-target";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM workspace_snapshot");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM users");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
     VALUES (?, 'Real Operator', 'operator@example.com', 1, ?, ?)`,
  ).run(PLATFORM_USER_ID, now, now);
  for (const [id, slug, name] of [
    [TARGET_WORKSPACE_ID, "audit-target", "Audit Target"],
  ]) {
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, slug, name, PLATFORM_USER_ID, now, now);
  }
});

after(() => {
  process.chdir(originalCwd);
});

test("platform intervention keeps real identity in platform audit and anonymizes the team ledger", () => {
  assert.equal(isPlatformAdminUserSync(PLATFORM_USER_ID), true);
  assert.equal(tryRecordWorkspaceAuditEventSync({
    workspaceId: TARGET_WORKSPACE_ID,
    title: "Real Operator rotated a credential",
    note: `Requested by operator@example.com (${PLATFORM_USER_ID})`,
    code: "runtime.credential_rotated",
    data: {
      actorId: PLATFORM_USER_ID,
      email: "operator@example.com",
      displayName: "Real Operator",
      runtimeId: "runtime-1",
    },
  }), true);

  const platformLog = listAuditLogsSync(PLATFORM_AUDIT_WORKSPACE_ID, { source: "platform_admin" })[0];
  assert.ok(platformLog);
  const platformData = JSON.parse(platformLog.dataJson) as Record<string, unknown>;
  assert.equal(platformData.actorUserId, PLATFORM_USER_ID);
  assert.equal(platformData.targetWorkspaceId, TARGET_WORKSPACE_ID);

  const teamEntry = readWorkspaceStateSync(TARGET_WORKSPACE_ID).ledger[0];
  const serializedTeamEntry = JSON.stringify(teamEntry);
  assert.match(teamEntry?.title ?? "", /平台运维/);
  assert.equal(serializedTeamEntry.includes(PLATFORM_USER_ID), false);
  assert.equal(serializedTeamEntry.includes("Real Operator"), false);
  assert.equal(serializedTeamEntry.includes("operator@example.com"), false);
});
