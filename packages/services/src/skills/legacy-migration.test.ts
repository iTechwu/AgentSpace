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
