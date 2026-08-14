import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  listAuditLogsSync,
  listSkillArtifactBindingsForSkillSync,
  readAssignmentArtifactDigestSync,
  readSkillArtifactByDigestSync,
  readStoredSkillActiveArtifactDigestSync,
  setStoredEmployeeSkillAssignmentsSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  createEmployeeSync,
  createSkillInstallationPlanSync,
  createWorkspaceSkillSync,
  migrateLegacySkillArtifactsSync,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
  upsertWorkspaceSkillFileSync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const testTosStorage = createTestTosAttachmentStorage();
const WORKSPACE_ID = "legacy-migration-test";

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync(WORKSPACE_ID);
  // resetWorkspaceStateSync deliberately never clears audit_log (it is a
  // tamper-evident, append-only log), so without this the note/name-based audit
  // queries below would match rows left by prior invocations and flake. Clear
  // only this dedicated test workspace's audit rows for a deterministic slate.
  getDatabase().prepare("DELETE FROM audit_log WHERE workspace_id = ?").run(WORKSPACE_ID);
  testTosStorage.clear();
  // Baseline: a fresh workspace auto-seeds builtin legacy skills; migrate them
  // first so each test only measures its own skills.
  migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID, limit: 1000 });
});

after(() => {
  testTosStorage.clear();
});

function createLegacySkill(name: string, extraFiles: Array<{ path: string; content: string }> = []) {
  const skill = createWorkspaceSkillSync({
    name,
    description: `${name} description`,
    content: `---\nname: ${name}\ndescription: legacy\n---\n# Body\n`,
  }, WORKSPACE_ID);
  for (const file of extraFiles) {
    upsertWorkspaceSkillFileSync({
      skillId: skill.id,
      path: file.path,
      content: file.content,
    }, WORKSPACE_ID);
  }
  return skill;
}

test("migrates a legacy skill into a bound artifact and maps assignments", () => {
  const skill = createLegacySkill("Legacy Alpha", [
    { path: "scripts/run.sh", content: "echo hi\n" },
  ]);
  createEmployeeSync({ name: "Atlas", role: "Researcher", origin: "manual" }, WORKSPACE_ID);
  setStoredEmployeeSkillAssignmentsSync("Atlas", [skill.id], WORKSPACE_ID);

  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });

  assert.equal(result.migrated, 1);
  assert.equal(result.failed, 0);
  const bindings = listSkillArtifactBindingsForSkillSync(skill.id, WORKSPACE_ID);
  assert.equal(bindings.length, 1);
  const digest = bindings[0]!;
  const artifact = readSkillArtifactByDigestSync(digest, WORKSPACE_ID);
  assert.ok(artifact);
  assert.equal(artifact.sourceType, "legacy");
  assert.equal(artifact.legacyIncomplete, false);
  // Active digest + assignment mapping moved onto the artifact…
  assert.equal(readStoredSkillActiveArtifactDigestSync(skill.id, WORKSPACE_ID), digest);
  assert.equal(
    readAssignmentArtifactDigestSync({ employeeName: "Atlas", skillId: skill.id, workspaceId: WORKSPACE_ID }),
    digest,
  );
  // …but no installation was created (不擅自赋可执行权).
  const audit = listAuditLogsSync(WORKSPACE_ID, { code: "skill.legacy_migrated" });
  assert.ok(audit.some((row) => row.note.includes(`"${skill.name}"`)));
});

test("is idempotent: a second run reports alreadyMigrated and creates nothing", () => {
  createLegacySkill("Legacy Beta");

  const first = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  const second = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });

  assert.equal(first.migrated, 1);
  assert.equal(second.migrated, 0);
  // Everything migrated by the baseline + first run is reported as already migrated.
  assert.equal(second.alreadyMigrated, first.migrated + first.alreadyMigrated);
});

test("marks artifacts with non-text files as legacy_incomplete and blocks installation", () => {
  const skill = createLegacySkill("Legacy Binary", [
    { path: "assets/logo.png", content: "not-really-png-bytes" },
  ]);

  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  assert.equal(result.migrated, 1);

  const digest = listSkillArtifactBindingsForSkillSync(skill.id, WORKSPACE_ID)[0]!;
  const artifact = readSkillArtifactByDigestSync(digest, WORKSPACE_ID);
  assert.equal(artifact?.legacyIncomplete, true);

  assert.throws(
    () => createSkillInstallationPlanSync({ workspaceId: WORKSPACE_ID, runtimeId: "rt-any", artifactDigest: digest }),
    /不完整/,
  );
});

test("reports skills without SKILL.md as failures and leaves them untouched", () => {
  const skill = createLegacySkill("Legacy Broken");
  // Remove the SKILL.md created by createWorkspaceSkillSync.
  getDatabase().prepare("DELETE FROM skill_file WHERE skill_id = ? AND path = 'SKILL.md'").run(skill.id);

  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });

  assert.equal(result.migrated, 0);
  assert.equal(result.failed, 1);
  assert.match(result.failures[0]!.reason, /SKILL\.md/);
  assert.equal(listSkillArtifactBindingsForSkillSync(skill.id, WORKSPACE_ID).length, 0);
});

test("honours the per-run limit", () => {
  createLegacySkill("Legacy One");
  createLegacySkill("Legacy Two");

  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID, limit: 1 });

  assert.equal(result.migrated, 1);
});

test("self-heals a partial migration: re-maps assignments and re-records the audit without rebuilding", () => {
  // Regression for the atomicity bug: Phase A (binding) used to gate the whole
  // migration, so a run that crashed after creating the binding but before
  // mapping assignments / writing the audit was judged complete and never
  // backfilled. Re-running must now reconcile the missing phases off the
  // surviving binding's digest.
  const skill = createLegacySkill("Legacy Selfheal", [
    { path: "scripts/run.sh", content: "echo hi\n" },
  ]);
  createEmployeeSync({ name: "Nova", role: "Researcher", origin: "manual" }, WORKSPACE_ID);
  setStoredEmployeeSkillAssignmentsSync("Nova", [skill.id], WORKSPACE_ID);

  // First run: full migration.
  const first = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  assert.equal(first.migrated, 1);
  const digest = listSkillArtifactBindingsForSkillSync(skill.id, WORKSPACE_ID)[0]!;
  assert.equal(readAssignmentArtifactDigestSync({ employeeName: "Nova", skillId: skill.id, workspaceId: WORKSPACE_ID }), digest);

  // Simulate a crash AFTER the binding landed but BEFORE B/C completed: wipe
  // this skill's assignment mapping and migration audit, keep the binding.
  getDatabase().prepare("UPDATE agent_skill SET skill_artifact_digest = NULL WHERE workspace_id = ? AND skill_id = ?").run(WORKSPACE_ID, skill.id);
  getDatabase().prepare("DELETE FROM audit_log WHERE workspace_id = ? AND code = ? AND data_json->>'skillId' = ?").run(WORKSPACE_ID, "skill.legacy_migrated", skill.id);
  assert.equal(readAssignmentArtifactDigestSync({ employeeName: "Nova", skillId: skill.id, workspaceId: WORKSPACE_ID }), undefined);

  // Second run: no fresh build (binding exists), but the missing phases reconcile.
  const second = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  assert.equal(second.migrated, 0, "the surviving binding must not trigger a rebuild");
  assert.equal(second.reconciled, 1, "the partial migration is self-healed, not silently skipped");
  // Assignment re-mapped onto the SAME digest (no new artifact)…
  assert.equal(readAssignmentArtifactDigestSync({ employeeName: "Nova", skillId: skill.id, workspaceId: WORKSPACE_ID }), digest);
  assert.equal(listSkillArtifactBindingsForSkillSync(skill.id, WORKSPACE_ID).length, 1, "no duplicate binding");
  // …and the audit re-recorded exactly once.
  const audit = listAuditLogsSync(WORKSPACE_ID, { code: "skill.legacy_migrated" })
    .filter((row) => row.note.includes(`"${skill.name}"`));
  assert.equal(audit.length, 1);
});

test("reconciles partial migrations even after the Phase-A build budget is exhausted", () => {
  // Regression: `limit` used to `break` the whole loop the moment the build
  // budget was spent, so an already-bound skill queued AFTER the budget ran out
  // never reached its cheap reconciliation — violating the doc's promise that
  // reconciliation is uncapped. `limit` must cap ONLY the expensive Phase-A
  // build, never the reconciliation of an already-bound skill.
  const skillA = createLegacySkill("Legacy Budget Fresh");
  const skillB = createLegacySkill("Legacy Budget Partial");
  createEmployeeSync({ name: "Orion", role: "Researcher", origin: "manual" }, WORKSPACE_ID);
  setStoredEmployeeSkillAssignmentsSync("Orion", [skillB.id], WORKSPACE_ID);

  // Fully migrate both first (skillA built fresh, skillB built fresh + mapped).
  migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID, limit: 1000 });
  const digestB = listSkillArtifactBindingsForSkillSync(skillB.id, WORKSPACE_ID)[0]!;
  assert.equal(readAssignmentArtifactDigestSync({ employeeName: "Orion", skillId: skillB.id, workspaceId: WORKSPACE_ID }), digestB);

  // Simulate a crash on skillB AFTER its binding landed but BEFORE B/C: wipe the
  // assignment mapping + migration audit, keep the binding. skillB now needs ONLY
  // cheap reconciliation. skillA is left fully migrated (alreadyMigrated).
  getDatabase().prepare("UPDATE agent_skill SET skill_artifact_digest = NULL WHERE workspace_id = ? AND skill_id = ?").run(WORKSPACE_ID, skillB.id);
  getDatabase().prepare("DELETE FROM audit_log WHERE workspace_id = ? AND code = ? AND data_json->>'skillId' = ?").run(WORKSPACE_ID, "skill.legacy_migrated", skillB.id);
  assert.equal(readAssignmentArtifactDigestSync({ employeeName: "Orion", skillId: skillB.id, workspaceId: WORKSPACE_ID }), undefined);

  // Re-run with limit:0 coerced to 1 — no Phase-A build budget at all. skillB is
  // bound so it must STILL reconcile, proving reconciliation is never starved by
  // the build cap. (skillA is fully migrated, so nothing wants a build anyway.)
  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID, limit: 0 });
  assert.equal(result.migrated, 0, "nothing builds — no fresh artifacts needed");
  assert.equal(result.reconciled, 1, "skillB reconciles despite zero build budget");
  assert.equal(
    readAssignmentArtifactDigestSync({ employeeName: "Orion", skillId: skillB.id, workspaceId: WORKSPACE_ID }),
    digestB,
    "skillB's assignment is re-mapped onto its surviving digest",
  );
});

test("does not duplicate the migration audit across repeat runs", () => {
  const skill = createLegacySkill("Legacy Once");

  migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });
  migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });

  const count = listAuditLogsSync(WORKSPACE_ID, { code: "skill.legacy_migrated" })
    .filter((row) => row.note.includes(`"${skill.name}"`)).length;
  assert.equal(count, 1, "exactly one migration audit per skill, regardless of how often maintenance re-runs");
});

test("leaves a modern (non-legacy) skill untouched: no backfill, no legacy audit", () => {
  // Regression: "has any binding" used to route modern skills onto the legacy
  // reconciliation path — backfilling a NULL assignment onto the OLDEST binding
  // (bindings are created_at ASC) and recording a bogus skill.legacy_migrated
  // audit. Only legacy-provenance artifacts are this migrator's business.
  const skill = createLegacySkill("Modern Multi-Version");
  createEmployeeSync({ name: "Vega", role: "Researcher", origin: "manual" }, WORKSPACE_ID);
  // Assign BEFORE any artifact exists, so the assignment has no digest yet — the
  // exact state the bug backfilled onto an arbitrary binding.
  setStoredEmployeeSkillAssignmentsSync("Vega", [skill.id], WORKSPACE_ID);
  assert.equal(
    readAssignmentArtifactDigestSync({ employeeName: "Vega", skillId: skill.id, workspaceId: WORKSPACE_ID }),
    undefined,
    "precondition: the legacy assignment has no artifact digest yet",
  );

  // Build TWO modern artifacts (sourceType "local"); the newer becomes active.
  // This is a modern multi-version lineage the legacy migrator must not touch.
  const v1 = buildAndPersistSkillArtifactSync({
    skillId: skill.id,
    name: skill.name,
    workspaceId: WORKSPACE_ID,
    sourceType: "local",
    files: [{ path: "SKILL.md", bytes: Buffer.from(`---\nname: ${skill.name}\ndescription: modern v1\n---\n# v1\n`) }],
  });
  const v2 = buildAndPersistSkillArtifactSync({
    skillId: skill.id,
    name: skill.name,
    workspaceId: WORKSPACE_ID,
    sourceType: "local",
    files: [{ path: "SKILL.md", bytes: Buffer.from(`---\nname: ${skill.name}\ndescription: modern v2\n---\n# v2\n`) }],
  });
  assert.notEqual(v1.digest, v2.digest, "two distinct modern versions");
  assert.equal(readStoredSkillActiveArtifactDigestSync(skill.id, WORKSPACE_ID), v2.digest, "the newer version is active");

  const result = migrateLegacySkillArtifactsSync({ workspaceId: WORKSPACE_ID });

  assert.equal(result.migrated, 0, "a modern skill is not (re)built by the legacy migrator");
  assert.equal(result.reconciled, 0, "a modern skill is not reconciled by the legacy migrator");
  assert.equal(
    readAssignmentArtifactDigestSync({ employeeName: "Vega", skillId: skill.id, workspaceId: WORKSPACE_ID }),
    undefined,
    "the empty assignment must not be backfilled onto the oldest modern binding",
  );
  const legacyAudit = listAuditLogsSync(WORKSPACE_ID, { code: "skill.legacy_migrated" })
    .filter((row) => row.note.includes(`"${skill.name}"`));
  assert.equal(legacyAudit.length, 0, "a modern skill must not receive a legacy_migrated audit");
});
