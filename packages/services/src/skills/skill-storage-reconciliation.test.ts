import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  listStoredWorkspaceSkillsSync,
  readWorkspaceStateRecordSync,
  replaceStoredWorkspaceSkillsSync,
  writeWorkspaceStateRecordSync,
} from "@dofe-agent/db";
import {
  createWorkspaceSkillSync,
  listWorkspaceSkillsSync,
  reconcileWorkspaceSkillStorageSync,
  resetWorkspaceStateSync,
} from "../index.ts";

beforeEach(() => {
  resetWorkspaceStateSync();
});

test("skill listing recovers snapshot skills missing from dedicated storage", () => {
  const recoverableSkill = createWorkspaceSkillSync({
    name: "snapshot-recovery-pack",
    description: "Recover this skill from the workspace snapshot.",
  });
  const storedSkills = listStoredWorkspaceSkillsSync();
  const retainedSkill = storedSkills.find((skill) => skill.id !== recoverableSkill.id);
  assert.ok(retainedSkill);

  replaceStoredWorkspaceSkillsSync([retainedSkill]);

  const listedSkills = listWorkspaceSkillsSync();

  assert.ok(listedSkills.some((skill) => skill.id === recoverableSkill.id));
});

test("skill reconciliation canonicalizes duplicate source identities and is idempotent", () => {
  const currentSkill = createWorkspaceSkillSync({
    name: "current-source-skill",
    description: "Current source identity.",
    sourceType: "skills.sh",
    sourceUrl: "https://skills.sh/example/repository/source-skill",
  });
  const state = readWorkspaceStateRecordSync();
  assert.ok(state);
  const historicalAlias = {
    ...currentSkill,
    id: "skill-historical-source-alias",
    name: "historical-source-skill",
    files: currentSkill.files.map((file) => ({
      ...file,
      id: `historical-${file.id}`,
    })),
  };
  writeWorkspaceStateRecordSync({
    ...state,
    skills: [historicalAlias, ...state.skills],
  });

  const firstResult = reconcileWorkspaceSkillStorageSync();
  const canonicalSnapshot = readWorkspaceStateRecordSync();
  const secondResult = reconcileWorkspaceSkillStorageSync();

  assert.deepEqual(firstResult.recoveredSkillIds, []);
  assert.equal(firstResult.snapshotUpdated, true);
  assert.ok(canonicalSnapshot?.skills.some((skill) => skill.id === currentSkill.id));
  assert.equal(canonicalSnapshot?.skills.some((skill) => skill.id === historicalAlias.id), false);
  assert.deepEqual(secondResult, {
    recoveredSkillIds: [],
    canonicalSkillCount: listStoredWorkspaceSkillsSync().length,
    snapshotUpdated: false,
  });
});

test("skill reconciliation rolls back all recovered skills when one snapshot skill conflicts", () => {
  const retainedSkill = listStoredWorkspaceSkillsSync()[0];
  assert.ok(retainedSkill?.files[0]);
  const now = new Date().toISOString();
  const validSkill = {
    id: "skill-valid-recovery",
    name: "valid-recovery",
    description: "Should roll back with the transaction.",
    sourceType: "manual",
    configJson: "{}",
    createdAt: now,
    updatedAt: now,
    files: [{
      id: "skill-file-valid-recovery",
      path: "SKILL.md",
      content: "# Valid recovery\n",
      createdAt: now,
      updatedAt: now,
    }],
  };
  const conflictingSkill = {
    ...validSkill,
    id: "skill-conflicting-recovery",
    name: "conflicting-recovery",
    files: [{
      ...validSkill.files[0],
      id: retainedSkill.files[0].id,
    }],
  };
  const state = readWorkspaceStateRecordSync();
  assert.ok(state);
  writeWorkspaceStateRecordSync({
    ...state,
    skills: [validSkill, conflictingSkill, ...state.skills],
  });

  assert.throws(
    () => reconcileWorkspaceSkillStorageSync(),
    /duplicate key value violates unique constraint/,
  );
  assert.equal(
    listStoredWorkspaceSkillsSync().some((skill) => skill.id === validSkill.id),
    false,
  );
});
